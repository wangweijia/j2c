/**
 * SubBridge 预翻译同步引擎
 *
 * 三步流程自动衔接：
 *   Step 1 — 提取字幕（自动从 textTracks 提取，或用户导入 SRT/VTT）
 *   Step 2 — 批量翻译全部字幕
 *   Step 3 — video.timeupdate 时间轴同步渲染
 *
 * 对外暴露 window.SubBridgeSyncEngine
 */
(function () {
  "use strict";

  /* ========== 状态 ========== */
  var engine = {
    /** @type {{startTime:number, endTime:number, text:string, translated:string}[]} */
    cues: [],
    active: false, // 是否启用预翻译模式
    translating: false, // 是否正在批量翻译中
    translateDone: false, // 翻译是否全部完成
    progress: { done: 0, total: 0, failed: 0 },
    videoEl: null,
    timeupdateBound: null,
    lastRenderedIdx: -1,
    abortFlag: false,
    /** @type {function|null} 外部注入的 renderSubtitle(original, translated) */
    onRender: null,
    /** @type {function|null} 外部注入的 renderStatus(text) */
    onStatus: null,
    /** @type {function|null} 外部注入的 clearOverlay() */
    onClear: null,
    /** @type {function|null} 外部注入的 onModeChange(active) */
    onModeChange: null,
    /** @type {function|null} 外部注入的 showPrompt(msg, onConfirm, onCancel) */
    onPrompt: null,
  };

  /* ========== Step 1: 提取字幕 ========== */

  /**
   * 尝试从 video.textTracks 自动提取全部字幕
   * @returns {{success:boolean, count:number, cues:Array}}
   */
  function autoExtractSubtitles() {
    if (!window.SubBridgeParser) return { success: false, count: 0, cues: [] };
    var result = window.SubBridgeParser.extractAllCuesFromVideo();
    if (!result.supported || !result.cues.length) {
      return { success: false, count: 0, cues: [] };
    }
    return { success: true, count: result.cues.length, cues: result.cues };
  }

  /**
   * 从用户上传的文件内容加载字幕
   * @param {string} content 文件文本内容
   * @param {string} filename 文件名（用于判断格式）
   * @returns {{success:boolean, count:number, cues:Array}}
   */
  function loadFromFile(content, filename) {
    if (!window.SubBridgeParser) return { success: false, count: 0, cues: [] };
    var cues = window.SubBridgeParser.parseSubtitleFile(content, filename);
    if (!cues || !cues.length) {
      return { success: false, count: 0, cues: [] };
    }
    return { success: true, count: cues.length, cues: cues };
  }

  /* ========== Step 2: 批量翻译 ========== */

  /**
   * 批量翻译所有 cue，翻译结果写入 cue.translated
   * @param {string} mode - 翻译模式 (online-free / local-free)
   * @param {function} onProgress - 回调 (done, total, failed)
   */
  async function batchTranslateAll(mode, onProgress) {
    if (!engine.cues.length) return;
    engine.translating = true;
    engine.translateDone = false;
    engine.abortFlag = false;
    engine.progress = { done: 0, total: engine.cues.length, failed: 0 };

    var translator = window.SubBridgeTranslator;
    if (!translator) {
      engine.translating = false;
      return;
    }

    for (var i = 0; i < engine.cues.length; i++) {
      if (engine.abortFlag) break;

      var cue = engine.cues[i];
      // 已有翻译则跳过
      if (cue.translated) {
        engine.progress.done++;
        if (onProgress) onProgress(engine.progress.done, engine.progress.total, engine.progress.failed);
        continue;
      }

      var text = translator.normalizeText(cue.text);
      if (!text) {
        cue.translated = cue.text;
        engine.progress.done++;
        if (onProgress) onProgress(engine.progress.done, engine.progress.total, engine.progress.failed);
        continue;
      }

      var lang = translator.detectLanguage(text);
      try {
        var result = await translator.translate(text, mode || "online-free", lang);
        cue.translated = result.translatedText || text;
      } catch (e) {
        cue.translated = text;
        engine.progress.failed++;
      }

      engine.progress.done++;
      if (onProgress) onProgress(engine.progress.done, engine.progress.total, engine.progress.failed);

      // 每翻译 1 条暂停一小段，避免 API 限速
      if (!engine.abortFlag && i < engine.cues.length - 1) {
        await sleep(80);
      }
    }

    engine.translating = false;
    engine.translateDone = !engine.abortFlag;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /* ========== Step 3: 时间轴同步渲染 ========== */

  /**
   * 二分查找当前时间对应的 cue 索引
   * 返回 -1 表示当前无字幕
   */
  function findCueAtTime(time) {
    var lo = 0;
    var hi = engine.cues.length - 1;
    var result = -1;

    while (lo <= hi) {
      var mid = (lo + hi) >>> 1;
      if (engine.cues[mid].startTime <= time) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (result >= 0 && engine.cues[result].endTime >= time) {
      return result;
    }
    return -1;
  }

  function onTimeUpdate() {
    if (!engine.active || !engine.videoEl) return;

    var currentTime = engine.videoEl.currentTime || 0;
    var idx = findCueAtTime(currentTime);

    if (idx === engine.lastRenderedIdx) return;
    engine.lastRenderedIdx = idx;

    if (idx === -1) {
      if (engine.onClear) engine.onClear();
      return;
    }

    var cue = engine.cues[idx];
    if (engine.onRender) {
      engine.onRender(cue.text, cue.translated || cue.text);
    }
    if (engine.onStatus) {
      engine.onStatus("预翻译 " + (idx + 1) + "/" + engine.cues.length);
    }
  }

  function startTimeSync() {
    var video = document.querySelector("video");
    if (!video) return false;

    engine.videoEl = video;
    engine.lastRenderedIdx = -1;
    engine.timeupdateBound = onTimeUpdate;
    video.addEventListener("timeupdate", engine.timeupdateBound);
    // 更高频的同步（250ms 间隔补充 timeupdate 的不足）
    engine._syncInterval = setInterval(onTimeUpdate, 250);
    return true;
  }

  function stopTimeSync() {
    if (engine.videoEl && engine.timeupdateBound) {
      engine.videoEl.removeEventListener("timeupdate", engine.timeupdateBound);
    }
    if (engine._syncInterval) {
      clearInterval(engine._syncInterval);
      engine._syncInterval = null;
    }
    engine.videoEl = null;
    engine.timeupdateBound = null;
    engine.lastRenderedIdx = -1;
  }

  /* ========== 完整自动流程 ========== */

  /**
   * 自动衔接三步流程：
   *  1) 尝试自动提取字幕
   *  2) 如果提取成功，弹出确认 → 用户确认后开始批量翻译
   *  3) 翻译完成后自动切换到时间轴同步模式
   *
   * @param {string} mode - 翻译模式
   */
  async function tryAutoFlow(mode) {
    if (engine.active || engine.translating) {
      return { success: false, reason: "already_active" };
    }

    // Step 1: 自动提取
    var extracted = autoExtractSubtitles();
    if (!extracted.success || extracted.count < 1) {
      // 提取失败，通知用户
      if (engine.onStatus) {
        engine.onStatus("未能自动提取字幕（Netflix DRM限制），请导入SRT/VTT文件");
      }
      return { success: false, reason: "no_cues", trackInfo: extracted };
    }

    // 提示用户
    var msg =
      "检测到 " + extracted.count + " 条字幕可预翻译。\n" + "预翻译后将获得零延迟的中文字幕体验。\n\n" + "是否开始全量预翻译？（预计需要数分钟）";

    promptUser(
      msg,
      function () {
        // 用户确认
        engine.cues = extracted.cues.map(function (c) {
          return { startTime: c.startTime, endTime: c.endTime, text: c.text, translated: "" };
        });
        startBatchAndSync(mode);
      },
      null,
    );

    return { success: true, count: extracted.count };
  }

  /**
   * 从文件导入后启动流程
   */
  function startFromFile(content, filename, mode) {
    var loaded = loadFromFile(content, filename);
    if (!loaded.success) {
      if (engine.onStatus) engine.onStatus("文件解析失败");
      return false;
    }

    engine.cues = loaded.cues.map(function (c) {
      return { startTime: c.startTime, endTime: c.endTime, text: c.text, translated: "" };
    });
    startBatchAndSync(mode);
    return true;
  }

  /**
   * 批量翻译 + 翻译完成后自动启动时间同步
   */
  async function startBatchAndSync(mode) {
    engine.active = false; // 翻译期间还不切换模式
    if (engine.onStatus) engine.onStatus("准备预翻译...");
    if (engine.onModeChange) engine.onModeChange(false);

    await batchTranslateAll(mode, function (done, total, failed) {
      if (engine.onStatus) {
        var pct = Math.round((done / total) * 100);
        var msg = "预翻译 " + done + "/" + total + " (" + pct + "%)";
        if (failed) msg += " 失败:" + failed;
        engine.onStatus(msg);
      }
    });

    if (engine.abortFlag) {
      if (engine.onStatus) engine.onStatus("预翻译已取消");
      engine.cues = [];
      return;
    }

    // 翻译完成，自动切换到同步模式
    engine.active = true;
    if (engine.onModeChange) engine.onModeChange(true);
    if (engine.onStatus) {
      engine.onStatus("预翻译完成 ✓ 共" + engine.cues.length + "条");
    }

    startTimeSync();
  }

  function promptUser(msg, onConfirm, onCancel) {
    if (engine.onPrompt) {
      engine.onPrompt(msg, onConfirm, onCancel);
    } else {
      // fallback: 使用原生 confirm
      if (confirm(msg)) {
        if (onConfirm) onConfirm();
      } else {
        if (onCancel) onCancel();
      }
    }
  }

  /* ========== 停止 & 重置 ========== */

  function deactivate() {
    engine.abortFlag = true;
    engine.active = false;
    engine.translateDone = false;
    stopTimeSync();
    engine.cues = [];
    engine.progress = { done: 0, total: 0, failed: 0 };
    if (engine.onModeChange) engine.onModeChange(false);
    if (engine.onStatus) engine.onStatus("SubBridge");
  }

  /* ========== 查询状态 ========== */

  function isActive() {
    return engine.active;
  }

  function isTranslating() {
    return engine.translating;
  }

  function getProgress() {
    return { done: engine.progress.done, total: engine.progress.total, failed: engine.progress.failed };
  }

  function getCueCount() {
    return engine.cues.length;
  }

  /* ========== 导出 SRT ========== */

  function exportTranslatedSRT() {
    if (!engine.cues.length) return "";

    var lines = [];
    for (var i = 0; i < engine.cues.length; i++) {
      var cue = engine.cues[i];
      lines.push(String(i + 1));
      lines.push(formatSRTTime(cue.startTime) + " --> " + formatSRTTime(cue.endTime));
      lines.push(cue.translated || cue.text);
      lines.push("");
    }
    return lines.join("\n");
  }

  function formatSRTTime(seconds) {
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);
    var ms = Math.round((seconds % 1) * 1000);
    return pad2(h) + ":" + pad2(m) + ":" + pad2(s) + "," + pad3(ms);
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }
  function pad3(n) {
    return n < 10 ? "00" + n : n < 100 ? "0" + n : String(n);
  }

  /* ========== 公开接口 ========== */

  window.SubBridgeSyncEngine = {
    // 绑定回调（由 contentScript 设置）
    setCallbacks: function (callbacks) {
      engine.onRender = callbacks.onRender || null;
      engine.onStatus = callbacks.onStatus || null;
      engine.onClear = callbacks.onClear || null;
      engine.onModeChange = callbacks.onModeChange || null;
      engine.onPrompt = callbacks.onPrompt || null;
    },

    // 自动流程
    tryAutoFlow: tryAutoFlow,

    // 手动文件导入流程
    startFromFile: startFromFile,

    // 控制
    deactivate: deactivate,
    isActive: isActive,
    isTranslating: isTranslating,
    getProgress: getProgress,
    getCueCount: getCueCount,

    // 导出
    exportTranslatedSRT: exportTranslatedSRT,
  };
})();
