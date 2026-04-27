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
    promptEl: null,
    queueRunning: false,
    pendingSegment: null,
    mergeTimer: null,
    renderTimer: null,
    hideTimer: null,
    translationVersion: 0,
    hiddenSubtitleEls: new Set(),
    prefetchTimer: null,
    prefetchReportedOk: null,
    syncEngineReady: false,
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

    // 预翻译确认弹窗
    const prompt = document.createElement("div");
    prompt.id = "subbridge-prompt";
    prompt.style.display = "none";
    prompt.innerHTML =
      '<div class="subbridge-prompt-box">' +
      '<div class="subbridge-prompt-msg"></div>' +
      '<div class="subbridge-prompt-btns">' +
      '<button class="subbridge-prompt-yes">开始预翻译</button>' +
      '<button class="subbridge-prompt-no">使用实时翻译</button>' +
      "</div></div>";

    document.documentElement.appendChild(container);
    document.documentElement.appendChild(prompt);

    state.overlayEl = container;
    state.originalEl = original;
    state.translatedEl = translated;
    state.statusEl = status;
    state.promptEl = prompt;
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
    for (const selector of subtitleSelectors) {
      const root = document.querySelector(selector);
      if (!root) continue;

      // 只取叶子 span（不含子 span），避免 Netflix 嵌套 span 导致文字被重复收集
      const allSpans = root.querySelectorAll("span");
      const lines = [];
      allSpans.forEach((el) => {
        if (el.querySelector("span")) return; // 跳过含子 span 的 wrapper
        const value = window.SubBridgeTranslator.normalizeText(el.textContent || "");
        if (value) {
          lines.push(value);
        }
      });

      const text = lines.length ? lines.join(" ") : root.textContent || "";
      const normalized = window.SubBridgeTranslator.normalizeText(text);
      if (normalized) {
        return normalized;
      }
    }

    return "";
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
    // 预翻译同步模式下，字幕由 timeupdate 驱动，MutationObserver 仅负责隐藏原生字幕
    if (window.SubBridgeSyncEngine && window.SubBridgeSyncEngine.isActive()) {
      hideNativeSubtitleElements();
      return;
    }

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

  function extractCueText(cue) {
    if (!cue) return "";

    const raw = typeof cue.text === "string" ? cue.text : "";
    const withoutTags = raw.replace(/<[^>]+>/g, " ").replace(/\n/g, " ");
    return window.SubBridgeTranslator.normalizeText(withoutTags);
  }

  function collectFutureCueTexts(secondsAhead) {
    const video = document.querySelector("video");
    if (!video || !video.textTracks) {
      return { supported: false, texts: [] };
    }

    const now = video.currentTime || 0;
    const end = now + secondsAhead;
    const texts = [];

    for (let trackIndex = 0; trackIndex < video.textTracks.length; trackIndex += 1) {
      const track = video.textTracks[trackIndex];
      try {
        if (track.mode === "disabled") {
          track.mode = "hidden";
        }
      } catch (error) {
        void error;
      }

      const cues = track.cues;
      if (!cues || !cues.length) {
        continue;
      }

      for (let i = 0; i < cues.length; i += 1) {
        const cue = cues[i];
        if (typeof cue.startTime !== "number") {
          continue;
        }

        if (cue.startTime < now || cue.startTime > end) {
          continue;
        }

        const text = extractCueText(cue);
        if (text) {
          texts.push(text);
        }
      }
    }

    return { supported: true, texts };
  }

  function reportPrefetchBadge(ok, title) {
    if (state.prefetchReportedOk === ok) {
      return;
    }

    state.prefetchReportedOk = ok;
    chrome.runtime.sendMessage({ type: "PREFETCH_BADGE", ok, title }, () => {
      void chrome.runtime.lastError;
    });
  }

  async function runPrefetch() {
    if (!state.settings.enabled || !state.settings.enablePrefetch15s) {
      reportPrefetchBadge(false, "15秒预获取已关闭");
      return;
    }

    const result = collectFutureCueTexts(15);
    if (!result.supported) {
      reportPrefetchBadge(false, "未读取到字幕轨道");
      return;
    }

    const uniqueTexts = [...new Set(result.texts)].slice(0, 8);
    if (!uniqueTexts.length) {
      reportPrefetchBadge(false, "当前未捕获未来15秒字幕");
      return;
    }

    reportPrefetchBadge(true, "已预获取未来15秒字幕");

    for (let i = 0; i < uniqueTexts.length; i += 1) {
      const text = uniqueTexts[i];
      const lang = window.SubBridgeTranslator.detectLanguage(text);
      await window.SubBridgeTranslator.translate(text, state.settings.mode, lang);
    }
  }

  function startPrefetchLoop() {
    if (state.prefetchTimer) {
      clearInterval(state.prefetchTimer);
      state.prefetchTimer = null;
    }

    state.prefetchTimer = setInterval(() => {
      void runPrefetch();
    }, 2500);

    void runPrefetch();
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
      void runPrefetch();
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

    if (message.type === "PRETRANSLATE_FILE") {
      // 从 popup 发来的文件内容
      if (window.SubBridgeSyncEngine) {
        var ok = window.SubBridgeSyncEngine.startFromFile(message.content, message.filename, state.settings.mode);
        sendResponse({ ok: ok });
      } else {
        sendResponse({ ok: false, error: "engine_not_ready" });
      }
      return true;
    }

    if (message.type === "PRETRANSLATE_AUTO") {
      if (window.SubBridgeSyncEngine) {
        window.SubBridgeSyncEngine.tryAutoFlow(state.settings.mode).then(function (result) {
          sendResponse({ ok: result && result.success, reason: result && result.reason, count: result && result.count });
        });
      } else {
        sendResponse({ ok: false, reason: "engine_not_loaded" });
      }
      return true;
    }

    if (message.type === "PRETRANSLATE_STOP") {
      if (window.SubBridgeSyncEngine) {
        window.SubBridgeSyncEngine.deactivate();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
      return true;
    }

    if (message.type === "PRETRANSLATE_STATUS") {
      var eng = window.SubBridgeSyncEngine;
      sendResponse({
        active: eng ? eng.isActive() : false,
        translating: eng ? eng.isTranslating() : false,
        progress: eng ? eng.getProgress() : { done: 0, total: 0, failed: 0 },
        cueCount: eng ? eng.getCueCount() : 0,
      });
      return true;
    }

    if (message.type === "PRETRANSLATE_EXPORT") {
      var srt = window.SubBridgeSyncEngine ? window.SubBridgeSyncEngine.exportTranslatedSRT() : "";
      sendResponse({ srt: srt });
      return true;
    }
  }

  function showSyncPrompt(msg, onConfirm, onCancel) {
    if (!state.promptEl) return;

    var msgEl = state.promptEl.querySelector(".subbridge-prompt-msg");
    var yesBtn = state.promptEl.querySelector(".subbridge-prompt-yes");
    var noBtn = state.promptEl.querySelector(".subbridge-prompt-no");

    msgEl.textContent = msg;
    state.promptEl.style.display = "flex";

    function cleanup() {
      state.promptEl.style.display = "none";
    }

    // 使用 once:true 避免多次调用导致监听器叠加
    yesBtn.addEventListener(
      "click",
      function () {
        cleanup();
        if (onConfirm) onConfirm();
      },
      { once: true },
    );
    noBtn.addEventListener(
      "click",
      function () {
        cleanup();
        if (onCancel) onCancel();
      },
      { once: true },
    );
  }

  function initSyncEngine() {
    if (!window.SubBridgeSyncEngine) return;

    window.SubBridgeSyncEngine.setCallbacks({
      onRender: renderSubtitle,
      onStatus: renderStatus,
      onClear: clearOverlay,
      onModeChange: function (active) {
        state.syncEngineReady = active;
        // 预翻译模式激活时隐藏原生字幕
        if (active) hideNativeSubtitleElements();
      },
      onPrompt: showSyncPrompt,
    });
    // 自动提取已移除：不应在用户未主动点击时弹出确认框
  }

  /**
   * 处理来自 subtitleInterceptor（MAIN world）的字幕 cues
   * 通过 window.postMessage 桥接，因为 MAIN world 无法直接调用 isolated world 函数
   */
  function handleInterceptedCues(cues) {
    if (!Array.isArray(cues) || cues.length === 0) return;
    if (!state.settings.enabled) return;
    if (!window.SubBridgeSyncEngine) return;

    // 已在运行中则忽略（用户手动操作优先）
    if (window.SubBridgeSyncEngine.isActive() || window.SubBridgeSyncEngine.isTranslating()) {
      return;
    }

    renderStatus("自动拦截到 " + cues.length + " 条字幕");
    showSyncPrompt(
      "已拦截到 " + cues.length + " 条完整字幕。\n是否启用「全量预翻译」以获得零延迟体验？\n（若遇到字幕不同步或翻译失败，请选择“使用实时翻译”）",
      function () {
        var ok = window.SubBridgeSyncEngine.startFromCues(cues, state.settings.mode);
        if (!ok) {
          renderStatus("启动预翻译失败，请重试");
        } else {
          renderStatus("开始预翻译...");
        }
      },
      function () {
        renderStatus("已使用实时翻译模式");
      }
    );
  }

  /** 监听来自 MAIN world subtitleInterceptor 的 postMessage */
  function registerInterceptorListener() {
    window.addEventListener("message", function (event) {
      // 只处理同窗口来源，防止跨页面注入
      if (event.source !== window) return;
      if (!event.data || event.data.source !== "subbridge-interceptor") return;
      if (event.data.type === "SUBBRIDGE_CUES") {
        handleInterceptedCues(event.data.cues);
      }
    });
  }

  async function init() {
    await loadSettings();
    createOverlay();
    applyOverlayStyles();
    hideNativeSubtitleElements();
    startObserver();
    startPrefetchLoop();
    handleSubtitleMutation();
    initSyncEngine();
    registerInterceptorListener();

    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  }

  void init();
})();
