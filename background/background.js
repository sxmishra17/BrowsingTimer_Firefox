/**
 * Browsing Timer — Background Script
 *
 * Core timer engine that tracks active browsing time per domain.
 * Pauses on: browser minimize, window focus loss, idle (120s), tab switch.
 * Resumes on: window focus gain, user activity, tab activation.
 * Flushes accumulated time to storage every 10 seconds.
 */
(function () {
  "use strict";

  /* ── State ─────────────────────────────────────────────────── */
  let currentTabId = null;
  let currentDomain = null;
  let timerStart = null;       // Date.now() when tracking started / resumed
  let pendingMs = 0;           // unflushed milliseconds for currentDomain
  let isPaused = true;
  let windowFocused = true;
  let userIdle = false;
  let globalEnabled = true;
  let flushTimer = null;

  const FLUSH_INTERVAL = 10_000; // 10 seconds
  const IDLE_SECONDS = 120;

  /* ── Helpers ───────────────────────────────────────────────── */

  /** Accumulate elapsed time since last checkpoint into pendingMs */
  function checkpoint() {
    if (timerStart !== null) {
      pendingMs += Date.now() - timerStart;
      timerStart = Date.now();
    }
  }

  /** Write pendingMs to storage and reset */
  async function flush() {
    checkpoint();
    if (currentDomain && pendingMs > 0) {
      await BT_Storage.addTime(currentDomain, pendingMs);
    }
    pendingMs = 0;
  }

  function startFlushTimer() {
    if (!flushTimer) {
      flushTimer = setInterval(() => flush(), FLUSH_INTERVAL);
    }
  }

  function stopFlushTimer() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }

  /** Can we actively track right now? */
  function canTrack() {
    return globalEnabled && windowFocused && !userIdle;
  }

  /* ── Core actions ──────────────────────────────────────────── */

  function pauseTracking() {
    if (isPaused) return;
    checkpoint();
    // flush synchronously-ish: fire and forget but data won't be lost
    flush();
    timerStart = null;
    isPaused = true;
    stopFlushTimer();
    updateBadge();
  }

  function resumeTracking() {
    if (!canTrack() || currentDomain === null) return;
    timerStart = Date.now();
    isPaused = false;
    startFlushTimer();
    updateBadge();
  }

  /**
   * Begin tracking a new tab. Pauses old domain first, then starts new one.
   * @param {number} tabId
   */
  async function switchToTab(tabId) {
    // Pause whatever was active
    if (!isPaused) {
      await flush();
      timerStart = null;
      isPaused = true;
      stopFlushTimer();
    }

    currentTabId = tabId;

    try {
      const tab = await browser.tabs.get(tabId);
      const domain = BT_Domains.extractDomain(tab.url);
      currentDomain = domain;

      if (domain && canTrack()) {
        timerStart = Date.now();
        isPaused = false;
        startFlushTimer();
      }
    } catch {
      // Tab may have been closed between events
      currentDomain = null;
    }
    updateBadge();
  }

  /**
   * Handle URL change within the same tab.
   */
  async function handleUrlChange(tabId, newUrl) {
    if (tabId !== currentTabId) return;
    const newDomain = BT_Domains.extractDomain(newUrl);
    if (newDomain === currentDomain) return;

    // Flush time for old domain
    if (!isPaused) {
      await flush();
    }

    currentDomain = newDomain;
    pendingMs = 0;

    if (newDomain && canTrack()) {
      timerStart = Date.now();
      isPaused = false;
      startFlushTimer();
    } else {
      timerStart = null;
      isPaused = true;
      stopFlushTimer();
    }
    updateBadge();
  }

  /* ── Badge ─────────────────────────────────────────────────── */

  async function updateBadge() {
    try {
      if (isPaused || !currentDomain) {
        await browser.browserAction.setBadgeText({ text: "" });
        return;
      }
      // Show a small green dot to indicate active tracking
      await browser.browserAction.setBadgeText({ text: "●" });
      await browser.browserAction.setBadgeBackgroundColor({ color: "#4CAF50" });
    } catch { /* ignore if popup not available */ }
  }

  /* ── Event listeners ───────────────────────────────────────── */

  // Tab activated (switched to)
  browser.tabs.onActivated.addListener(async (activeInfo) => {
    await switchToTab(activeInfo.tabId);
  });

  // Tab URL changed (navigation within same tab)
  browser.tabs.onUpdated.addListener((tabId, changeInfo, _tab) => {
    if (changeInfo.url) {
      handleUrlChange(tabId, changeInfo.url);
    }
  });

  // Tab closed
  browser.tabs.onRemoved.addListener((tabId) => {
    if (tabId === currentTabId) {
      pauseTracking();
      currentTabId = null;
      currentDomain = null;
    }
  });

  // Window focus changed
  browser.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === browser.windows.WINDOW_ID_NONE) {
      windowFocused = false;
      pauseTracking();
    } else {
      windowFocused = true;
      // Find the active tab in the focused window
      const tabs = await browser.tabs.query({ active: true, windowId });
      if (tabs.length > 0) {
        await switchToTab(tabs[0].id);
      } else {
        resumeTracking();
      }
    }
  });

  // Idle detection – 120 second threshold
  browser.idle.setDetectionInterval(IDLE_SECONDS);
  browser.idle.onStateChanged.addListener((state) => {
    if (state === "active") {
      userIdle = false;
      resumeTracking();
    } else {
      // "idle" or "locked"
      userIdle = true;
      pauseTracking();
    }
  });

  // Listen for global toggle changes from popup
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "trackingEnabled" in changes) {
      globalEnabled = changes.trackingEnabled.newValue !== false;
      if (globalEnabled) {
        resumeTracking();
      } else {
        pauseTracking();
      }
    }
  });

  // Fresh visit detection via webNavigation
  browser.webNavigation.onCommitted.addListener((details) => {
    // Only track main frame navigations
    if (details.frameId !== 0) return;
    const domain = BT_Domains.extractDomain(details.url);
    if (!domain) return;

    // Count every navigation as a visit
    const freshTypes = new Set(["typed", "auto_bookmark", "generated"]);
    const isFresh = freshTypes.has(details.transitionType);
    BT_Storage.addVisit(domain, isFresh);
  });

  // Daily cleanup alarm
  browser.alarms.create("dailyCleanup", { periodInMinutes: 1440 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "dailyCleanup") {
      BT_Storage.pruneOldData();
    }
  });

  /* ── Startup ───────────────────────────────────────────────── */

  async function init() {
    // Load global enabled state
    globalEnabled = await BT_Storage.isTrackingEnabled();

    // Prune old data on startup
    await BT_Storage.pruneOldData();

    // Start tracking the currently active tab
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0) {
        windowFocused = true;
        await switchToTab(tabs[0].id);
      }
    } catch { /* first install, no tabs yet */ }
  }

  init();
})();
