(function () {
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

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    observer: null,
    lastSubtitle: "",
    overlayEl: null,
    originalEl: null,
    translatedEl: null,
    statusEl: null,
    renderTimer: null,
    hideTimer: null,
    translationVersion: 0,
    hiddenSubtitleEls: new Set(),
  };

  function hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }

    return String(hash >>> 0);
  }

  const subtitleSelectors = [
    ".player-timedtext",
    ".player-timedtext-text-container",
    "div[data-uia='player-subtitle']",
    ".watch-video--player-view .player-timedtext-text-container",
  ];

  const nativeSubtitleSelectors = [
    ".player-timedtext",
    ".player-timedtext-text-container",
    "div[data-uia='player-subtitle']",
    ".watch-video--player-view .player-timedtext",
  ];

  function createOverlay() {
    if (state.overlayEl) return;

    const container = document.createElement("div");
    container.id = "subbridge-overlay";

    const original = document.createElement("div");
    original.className = "subbridge-line subbridge-original";

    const translated = document.createElement("div");
    translated.className = "subbridge-line subbridge-translated";

    const status = document.createElement("div");
    status.className = "subbridge-status";
    status.textContent = "SubBridge";

    container.appendChild(original);
    container.appendChild(translated);
    container.appendChild(status);

    document.documentElement.appendChild(container);

    state.overlayEl = container;
    state.originalEl = original;
    state.translatedEl = translated;
    state.statusEl = status;
  }

  function hideNativeSubtitleElements() {
    if (!state.settings.hideNativeSubtitles) {
      restoreNativeSubtitleElements();
      return;
    }

    nativeSubtitleSelectors.forEach((selector) => {
      const nodes = document.querySelectorAll(selector);
      nodes.forEach((el) => {
        if (!el || el.closest("#subbridge-overlay")) {
          return;
        }

        if (!el.dataset.subbridgePrevVisibility) {
          el.dataset.subbridgePrevVisibility = el.style.visibility || "";
          el.dataset.subbridgePrevOpacity = el.style.opacity || "";
        }

        el.style.visibility = "hidden";
        el.style.opacity = "0";
        state.hiddenSubtitleEls.add(el);
      });
    });
  }

  function restoreNativeSubtitleElements() {
    state.hiddenSubtitleEls.forEach((el) => {
      if (!el || !el.isConnected) {
        return;
      }

      el.style.visibility = el.dataset.subbridgePrevVisibility || "";
      el.style.opacity = el.dataset.subbridgePrevOpacity || "";
      delete el.dataset.subbridgePrevVisibility;
      delete el.dataset.subbridgePrevOpacity;
    });

    state.hiddenSubtitleEls.clear();
  }

  function applyOverlayStyles() {
    if (!state.overlayEl) return;

    state.overlayEl.style.bottom = state.settings.bottomOffset + "px";
    state.overlayEl.style.fontSize = state.settings.fontSize + "px";
    state.overlayEl.style.setProperty("--subbridge-bg-opacity", String(state.settings.bgOpacity));
    state.statusEl.style.display = state.settings.showStatusBadge ? "block" : "none";

    if (!state.settings.enabled) {
      state.overlayEl.style.display = "none";
      return;
    }

    state.overlayEl.style.display = "flex";
  }

  function renderSubtitle(originalText, translatedText) {
    if (!state.overlayEl) return;

    const displayMode = state.settings.displayMode;

    state.originalEl.textContent = originalText || "";
    state.translatedEl.textContent = translatedText || "";

    if (displayMode === "zh-only") {
      state.originalEl.style.display = "none";
      state.translatedEl.style.display = "block";
    } else if (displayMode === "original-only") {
      state.originalEl.style.display = "block";
      state.translatedEl.style.display = "none";
    } else {
      state.originalEl.style.display = "block";
      state.translatedEl.style.display = "block";
    }

    cancelClearOverlay();
  }

  function renderStatus(text) {
    if (!state.statusEl) return;
    state.statusEl.textContent = text;
  }

  function clearOverlay() {
    if (!state.originalEl || !state.translatedEl) return;
    state.originalEl.textContent = "";
    state.translatedEl.textContent = "";
    state.lastSubtitle = "";
  }

  function scheduleClearOverlay() {
    // 每次重新计时，避免字幕就续出现时清屏误辦
    if (state.hideTimer) {
      clearTimeout(state.hideTimer);
    }

    state.hideTimer = setTimeout(() => {
      state.hideTimer = null;
      clearOverlay();
    }, 350);
  }

  function cancelClearOverlay() {
    if (state.hideTimer) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
  }

  function extractSubtitleText() {
    let allText = "";
    for (const selector of subtitleSelectors) {
      const nodes = document.querySelectorAll(selector);
      if (!nodes.length) continue;

      const lines = [];
      nodes.forEach((root) => {
        // 尝试提取叶子 span
        const allSpans = root.querySelectorAll("span");
        let hasLeafSpans = false;
        allSpans.forEach((el) => {
          if (el.querySelector("span")) return;
          const value = window.SubBridgeTranslator.normalizeText(el.textContent || "");
          if (value) {
            lines.push(value);
            hasLeafSpans = true;
          }
        });

        // 如果没有提取到任何叶子 span，则直接读取 root.textContent
        if (!hasLeafSpans) {
          const text = root.textContent || "";
          const value = window.SubBridgeTranslator.normalizeText(text);
          if (value) lines.push(value);
        }
      });

      if (lines.length) {
        allText = lines.join(" ");
        break; // 匹配到一个 selector 就结束，避免重复
      }
    }

    return window.SubBridgeTranslator.normalizeText(allText);
  }

  function buildSubtitleSegment(text) {
    const normalizedText = window.SubBridgeTranslator.normalizeText(text);
    if (!normalizedText) {
      return null;
    }

    return {
      id: hashText(normalizedText),
      text: normalizedText,
      timestamp: Date.now(),
      lang: window.SubBridgeTranslator.detectLanguage(normalizedText),
    };
  }

  async function runTranslatePipeline(segment) {
    if (!segment || !segment.text || !state.settings.enabled) return;

    const version = ++state.translationVersion;
    renderStatus("翻译中...");

    const result = await window.SubBridgeTranslator.translate(segment.text, state.settings.mode, segment.lang);
    const delay = Number(state.settings.subtitleDelayMs) || 0;

    if (state.renderTimer) {
      clearTimeout(state.renderTimer);
    }

    state.renderTimer = setTimeout(
      () => {
        if (version !== state.translationVersion) {
          return;
        }

        renderSubtitle(result.originalText, result.translatedText);
        renderStatus(result.fromCache ? "缓存命中" : "实时翻译");
      },
      Math.max(0, Math.min(500, delay)),
    );
  }

  async function processQueue() {
    if (state.queueRunning) return;

    state.queueRunning = true;
    try {
      while (state.pendingSegment) {
        const segment = state.pendingSegment;
        state.pendingSegment = null;
        await runTranslatePipeline(segment);
      }
    } finally {
      state.queueRunning = false;
    }
  }

  function enqueueSubtitle(text) {
    const segment = buildSubtitleSegment(text);
    if (!segment || segment.text === state.lastSubtitle) return;

    state.lastSubtitle = segment.text;
    if (state.mergeTimer) {
      clearTimeout(state.mergeTimer);
    }

    const mergeBase = Number(state.settings.mergeDebounceMs) || 180;
    const delayAdjust = Math.min(0, Number(state.settings.subtitleDelayMs) || 0);
    const waitMs = Math.max(40, Math.min(320, mergeBase + delayAdjust));

    state.mergeTimer = setTimeout(() => {
      state.pendingSegment = segment;
      void processQueue();
    }, waitMs);
  }

  function handleSubtitleMutation() {
    const current = extractSubtitleText();

    if (!current) {
      scheduleClearOverlay();
      return;
    }

    cancelClearOverlay();
    hideNativeSubtitleElements();
    enqueueSubtitle(current);
  }

  function startObserver() {
    if (state.observer) return;

    state.observer = new MutationObserver(() => {
      handleSubtitleMutation();
    });

    state.observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }



  async function loadSettings() {
    const keys = Object.keys(DEFAULT_SETTINGS);
    const stored = await chrome.storage.sync.get(keys);

    state.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
    };
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== "sync") return;

    let changed = false;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (changes[key]) {
        state.settings[key] = changes[key].newValue;
        changed = true;
      }
    }

    if (changed) {
      applyOverlayStyles();
      hideNativeSubtitleElements();
    }
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (!message || !message.type) return;

    if (message.type === "TOGGLE_OVERLAY") {
      state.settings.enabled = !state.settings.enabled;
      chrome.storage.sync.set({ enabled: state.settings.enabled });
      applyOverlayStyles();
      renderStatus(state.settings.enabled ? "已启用" : "已暂停");
    }
  }

  async function init() {
    await loadSettings();
    createOverlay();
    applyOverlayStyles();
    hideNativeSubtitleElements();
    startObserver();
    handleSubtitleMutation();

    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  }

  void init();
})();
