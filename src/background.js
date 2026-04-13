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
