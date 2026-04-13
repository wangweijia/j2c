const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "online-free",
  displayMode: "bilingual",
  fontSize: 30,
  bottomOffset: 88,
  bgOpacity: 0.35,
  subtitleDelayMs: 0,
  mergeDebounceMs: 180,
  showStatusBadge: true,
  hideNativeSubtitles: true,
  enablePrefetch15s: true,
};

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const next = {};

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof stored[key] === "undefined") {
      next[key] = DEFAULT_SETTINGS[key];
    }
  }

  if (Object.keys(next).length) {
    await chrome.storage.sync.set(next);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "PREFETCH_BADGE") {
    return;
  }

  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    sendResponse({ ok: false });
    return;
  }

  const text = message.ok ? "YES" : "NO";
  const color = message.ok ? "#1f8f4b" : "#8f2a1f";
  const title = message.title || (message.ok ? "15秒预获取可用" : "15秒预获取不可用");

  chrome.action.setBadgeBackgroundColor({ tabId, color }, () => {
    void chrome.runtime.lastError;
  });

  chrome.action.setBadgeText({ tabId, text }, () => {
    void chrome.runtime.lastError;
  });

  chrome.action.setTitle({ tabId, title }, () => {
    void chrome.runtime.lastError;
  });

  sendResponse({ ok: true });
  return true;
});
