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
  myMemoryEmail: "",
};

const fields = {
  enabled: document.getElementById("enabled"),
  mode: document.getElementById("mode"),
  displayMode: document.getElementById("displayMode"),
  fontSize: document.getElementById("fontSize"),
  bottomOffset: document.getElementById("bottomOffset"),
  bgOpacity: document.getElementById("bgOpacity"),
  subtitleDelayMs: document.getElementById("subtitleDelayMs"),
  mergeDebounceMs: document.getElementById("mergeDebounceMs"),
  showStatusBadge: document.getElementById("showStatusBadge"),
  hideNativeSubtitles: document.getElementById("hideNativeSubtitles"),
  enablePrefetch15s: document.getElementById("enablePrefetch15s"),
  myMemoryEmail: document.getElementById("myMemoryEmail"),
};

const values = {
  fontSize: document.getElementById("fontSizeValue"),
  bottomOffset: document.getElementById("bottomOffsetValue"),
  bgOpacity: document.getElementById("bgOpacityValue"),
  subtitleDelayMs: document.getElementById("subtitleDelayMsValue"),
  mergeDebounceMs: document.getElementById("mergeDebounceMsValue"),
};

const statusEl = document.getElementById("status");

function renderValues() {
  values.fontSize.textContent = fields.fontSize.value + " px";
  values.bottomOffset.textContent = fields.bottomOffset.value + " px";
  values.bgOpacity.textContent = Number(fields.bgOpacity.value).toFixed(2);
  values.subtitleDelayMs.textContent = Number(fields.subtitleDelayMs.value) + " ms";
  values.mergeDebounceMs.textContent = Number(fields.mergeDebounceMs.value) + " ms";
}

async function loadSettings() {
  const data = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const settings = { ...DEFAULT_SETTINGS, ...data };

  fields.enabled.checked = settings.enabled;
  fields.mode.value = settings.mode;
  fields.displayMode.value = settings.displayMode;
  fields.fontSize.value = settings.fontSize;
  fields.bottomOffset.value = settings.bottomOffset;
  fields.bgOpacity.value = settings.bgOpacity;
  fields.subtitleDelayMs.value = settings.subtitleDelayMs;
  fields.mergeDebounceMs.value = settings.mergeDebounceMs;
  fields.showStatusBadge.checked = settings.showStatusBadge;
  fields.hideNativeSubtitles.checked = settings.hideNativeSubtitles;
  fields.enablePrefetch15s.checked = settings.enablePrefetch15s;
  fields.myMemoryEmail.value = settings.myMemoryEmail || "";

  renderValues();
}

async function saveSettings() {
  const payload = {
    enabled: fields.enabled.checked,
    mode: fields.mode.value,
    displayMode: fields.displayMode.value,
    fontSize: Number(fields.fontSize.value),
    bottomOffset: Number(fields.bottomOffset.value),
    bgOpacity: Number(fields.bgOpacity.value),
    subtitleDelayMs: Number(fields.subtitleDelayMs.value),
    mergeDebounceMs: Number(fields.mergeDebounceMs.value),
    showStatusBadge: fields.showStatusBadge.checked,
    hideNativeSubtitles: fields.hideNativeSubtitles.checked,
    enablePrefetch15s: fields.enablePrefetch15s.checked,
    myMemoryEmail: (fields.myMemoryEmail.value || "").trim(),
  };

  await chrome.storage.sync.set(payload);
  renderValues();

  statusEl.textContent = "设置已保存";
  setTimeout(() => {
    statusEl.textContent = "";
  }, 1200);
}

Object.values(fields).forEach((el) => {
  el.addEventListener("change", saveSettings);
  if (el.type === "range") {
    el.addEventListener("input", renderValues);
  }
});

void loadSettings();
