/**
 * SubBridge 预翻译同步引擎
 *
 * 流程：
 *   Step 1 — 提取字幕（网络拦截 / textTracks / SRT 导入）
 *   Step 2 — 滚动窗口翻译（只翻当前播放位置往后 N 分钟，按需追加）
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
    active: false,        // 是否启用预翻译模式
    translating: false,   // 是否正在翻译某个窗口
    translateDone: false, // 所有 cue 是否已翻译完
    progress: { done: 0, total: 0, failed: 0 },
    videoEl: null,
    timeupdateBound: null,
    lastRenderedIdx: -1,
    abortFlag: false,
    /** 滚动窗口配置 */
    windowSecs: 5 * 60,      // 每次翻译向前看多远（秒）
    triggerBuffer: 2 * 60,   // 剩余缓冲低于此值时触发下一窗口
    translationHorizon: 0,   // 已安排翻译的时间上限（秒）
    windowBusy: false,       // 当前是否有窗口在翻译中
    windowMode: "online-free",
    _windowInterval: null,   // 滚动窗口监控定时器
    /** @type {function|null} */
    onRender: null,
    onStatus: null,
    onClear: null,
    onModeChange: null,
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

  /* ========== Step 2: 滚动窗口翻译 ========== */

  /**
   * 翻译一个时间窗口内尚未翻译的 cues
   * @param {number} fromTime  - 窗口起始时间（秒）
   * @param {number} toTime    - 窗口结束时间（秒）
   */
  async function translateWindow(fromTime, toTime) {
    if (engine.windowBusy || engine.abortFlag) return;

    var translator = window.SubBridgeTranslator;
    if (!translator) return;

    // 收集窗口内未翻译的 cue
    var toTranslate = [];
    for (var i = 0; i < engine.cues.length; i++) {
      var c = engine.cues[i];
      if (c.startTime < fromTime - 0.5) continue;
      if (c.startTime > toTime) break;
      if (!c.translated) toTranslate.push(i);
    }

    if (!toTranslate.length) return;

    engine.windowBusy = true;
    engine.translating = true;
    var total = toTranslate.length;
    var done = 0;
    var failed = 0;

    for (var k = 0; k < toTranslate.length; k++) {
      if (engine.abortFlag) break;

      var cue = engine.cues[toTranslate[k]];
      if (cue.translated) { done++; continue; }

      var text = translator.normalizeText(cue.text);
      if (!text) {
        cue.translated = cue.text;
        done++;
        continue;
      }

      var lang = translator.detectLanguage(text);
      try {
        var result = await translator.translate(text, engine.windowMode, lang);
        cue.translated = result.translatedText || text;
      } catch (e) {
        cue.translated = text;
        failed++;
      }

      done++;
      engine.progress.done++;
      engine.progress.failed += failed > 0 ? 1 : 0;

      if (engine.onStatus) {
        var pct = total > 0 ? Math.round((done / total) * 100) : 100;
        var msg = "预翻译窗口 " + done + "/" + total + " (" + pct + "%)";
        if (failed) msg += " 失败:" + failed;
        engine.onStatus(msg);
      }

      // 限速：每条间隔 80ms，避免 API 被封
      if (!engine.abortFlag && k < toTranslate.length - 1) {
        await sleep(80);
      }
    }

    engine.windowBusy = false;
    engine.translating = false;

    if (!engine.abortFlag && engine.onStatus) {
      var horizonMin = Math.floor(engine.translationHorizon / 60);
      engine.onStatus("已缓存至 " + horizonMin + " 分" + Math.floor(engine.translationHorizon % 60) + " 秒");
    }
  }

  /**
   * 按需检查是否需要翻译下一个窗口
   * 判断条件：距离当前播放位置的翻译缓冲 < triggerBuffer
   */
  function checkAndAdvanceWindow() {
    if (engine.windowBusy || engine.abortFlag || !engine.active) return;

    var video = engine.videoEl || document.querySelector("video");
    var currentTime = (video && video.currentTime) || 0;

    // 判断是否需要翻译更多
    if (engine.translationHorizon - currentTime >= engine.triggerBuffer) return;

    // 如果用户 seek 到 horizon 之后，从当前位置重新开始
    var fromTime = Math.max(engine.translationHorizon, currentTime);
    var toTime = fromTime + engine.windowSecs;
    engine.translationHorizon = toTime; // 先更新 horizon，防止并发触发

    void translateWindow(fromTime, toTime);
  }

  /** 启动滚动窗口监控定时器 */
  function startWindowMonitor(mode) {
    engine.windowMode = mode || "online-free";
    if (engine._windowInterval) clearInterval(engine._windowInterval);
    // 每 3 秒检查一次是否需要翻译下一窗口
    engine._windowInterval = setInterval(checkAndAdvanceWindow, 3000);
    // 立即触发第一次翻译
    checkAndAdvanceWindow();
  }

  /** 停止滚动窗口监控 */
  function stopWindowMonitor() {
    if (engine._windowInterval) {
      clearInterval(engine._windowInterval);
      engine._windowInterval = null;
    }
    engine.windowBusy = false;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
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
    // 已经启动则跳过，避免重复添加事件监听器
    if (engine.videoEl) return true;

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
   * 直接使用网络拦截到的 cues 启动预翻译
   * 跳过 Step1 提取和确认对话框，直接进入批量翻译 + 时间轴同步
   * @param {{startTime:number, endTime:number, text:string}[]} cues
   * @param {string} mode - 翻译模式
   */
  function startFromCues(cues, mode) {
    if (engine.active || engine.translating) {
      return false; // 已在运行中，不重复启动
    }
    if (!cues || !cues.length) {
      return false;
    }

    engine.cues = cues.map(function (c) {
      return { startTime: c.startTime, endTime: c.endTime, text: c.text, translated: "" };
    });

    startBatchAndSync(mode);
    return true;
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
   * 启动滚动窗口翻译 + 时间轴同步
   *
   * 策略：
   * 1. 立即激活 timeupdate 同步（未翻译的 cue 显示原文，翻译完成后自动切换）
   * 2. 从当前播放位置开始，只翻接下来 windowSecs 的内容
   * 3. 每 3 秒检查一次，缓冲低于 triggerBuffer 时翻译下一窗口
   */
  async function startBatchAndSync(mode) {
    if (engine.onStatus) engine.onStatus("准备滚动预翻译...");

    engine.windowMode = mode || "online-free";
    engine.progress = { done: 0, total: engine.cues.length, failed: 0 };

    // 立即启动时间轴同步（用户立即看到原文兜底）
    var syncStarted = startTimeSync();
    engine.active = syncStarted;
    if (engine.onModeChange) engine.onModeChange(syncStarted);

    if (!engine.active) {
      if (engine.onStatus) engine.onStatus("未找到视频元素，无法启动");
      return;
    }

    // 从当前播放位置开始设置 horizon
    var video = engine.videoEl || document.querySelector("video");
    var currentTime = (video && video.currentTime) || 0;
    engine.translationHorizon = currentTime;

    // 启动滚动窗口监控（立即翻译第一个窗口）
    startWindowMonitor(mode);
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
    engine.translating = false;
    engine.translationHorizon = 0;
    stopWindowMonitor();
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

    // 自动流程（从 textTracks 提取）
    tryAutoFlow: tryAutoFlow,

    // 手动文件导入流程
    startFromFile: startFromFile,

    // 网络拦截 cues 直接启动（最优先）
    startFromCues: startFromCues,

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
