const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "online-free",
  displayMode: "bilingual",
  subtitleDelayMs: 0,
};

const enabledEl = document.getElementById("enabled");
const modeEl = document.getElementById("mode");
const displayModeEl = document.getElementById("displayMode");
const subtitleDelayEl = document.getElementById("subtitleDelayMs");

async function loadSettings() {
  const data = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));

  enabledEl.checked = typeof data.enabled === "boolean" ? data.enabled : DEFAULT_SETTINGS.enabled;
  modeEl.value = data.mode || DEFAULT_SETTINGS.mode;
  displayModeEl.value = data.displayMode || DEFAULT_SETTINGS.displayMode;
  subtitleDelayEl.value = String(typeof data.subtitleDelayMs === "number" ? data.subtitleDelayMs : DEFAULT_SETTINGS.subtitleDelayMs);
}

async function persist() {
  await chrome.storage.sync.set({
    enabled: enabledEl.checked,
    mode: modeEl.value,
    displayMode: displayModeEl.value,
    subtitleDelayMs: Number(subtitleDelayEl.value),
  });
}

enabledEl.addEventListener("change", persist);
modeEl.addEventListener("change", persist);
displayModeEl.addEventListener("change", persist);
subtitleDelayEl.addEventListener("change", persist);

void loadSettings();
