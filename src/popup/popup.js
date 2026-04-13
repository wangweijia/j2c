const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "online-free",
  displayMode: "bilingual",
  subtitleDelayMs: 0,
  hideNativeSubtitles: true,
  enablePrefetch15s: true,
};

const enabledEl = document.getElementById("enabled");
const modeEl = document.getElementById("mode");
const displayModeEl = document.getElementById("displayMode");
const subtitleDelayEl = document.getElementById("subtitleDelayMs");
const hideNativeSubtitlesEl = document.getElementById("hideNativeSubtitles");
const enablePrefetch15sEl = document.getElementById("enablePrefetch15s");

async function loadSettings() {
  const data = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));

  enabledEl.checked = typeof data.enabled === "boolean" ? data.enabled : DEFAULT_SETTINGS.enabled;
  modeEl.value = data.mode || DEFAULT_SETTINGS.mode;
  displayModeEl.value = data.displayMode || DEFAULT_SETTINGS.displayMode;
  subtitleDelayEl.value = String(typeof data.subtitleDelayMs === "number" ? data.subtitleDelayMs : DEFAULT_SETTINGS.subtitleDelayMs);
  hideNativeSubtitlesEl.checked = typeof data.hideNativeSubtitles === "boolean" ? data.hideNativeSubtitles : DEFAULT_SETTINGS.hideNativeSubtitles;
  enablePrefetch15sEl.checked = typeof data.enablePrefetch15s === "boolean" ? data.enablePrefetch15s : DEFAULT_SETTINGS.enablePrefetch15s;
}

async function persist() {
  await chrome.storage.sync.set({
    enabled: enabledEl.checked,
    mode: modeEl.value,
    displayMode: displayModeEl.value,
    subtitleDelayMs: Number(subtitleDelayEl.value),
    hideNativeSubtitles: hideNativeSubtitlesEl.checked,
    enablePrefetch15s: enablePrefetch15sEl.checked,
  });
}

enabledEl.addEventListener("change", persist);
modeEl.addEventListener("change", persist);
displayModeEl.addEventListener("change", persist);
subtitleDelayEl.addEventListener("change", persist);
hideNativeSubtitlesEl.addEventListener("change", persist);
enablePrefetch15sEl.addEventListener("change", persist);

void loadSettings();
