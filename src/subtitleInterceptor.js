/**
 * SubBridge 字幕网络拦截器
 *
 * 运行环境: MAIN world, document_start
 * 职责:
 *   - 在 Netflix JS 运行前 hook window.fetch 和 XMLHttpRequest
 *   - 检测 TTML 字幕文件响应，解析为标准 cue 数组
 *   - 通过 window.postMessage 转发给 isolated world 的 contentScript
 */
(function () {
  "use strict";

  /** 已处理过的 URL key（去掉 query 参数后的 hostname+path），防止重复触发 */
  var _sentKeys = new Set();

  /* ========== URL 识别 ========== */

  /**
   * 判断 URL 是否为 Netflix 字幕 CDN 请求
   * 主要特征：
   *   *.nflxvideo.net  —— Netflix 主字幕 CDN
   *   *.nflxext.com    —— Netflix 辅助 CDN（路径含 .xml/.ttml/.dfxp）
   *   其他含 .ttml/.dfxp 后缀的路径
   */
  function isSubtitleUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (url.indexOf("nflxvideo.net") !== -1) return true;
    if (url.indexOf("nflxext.com") !== -1) {
      return url.indexOf(".xml") !== -1 || url.indexOf(".ttml") !== -1 || url.indexOf(".dfxp") !== -1;
    }
    if (url.indexOf(".ttml") !== -1 || url.indexOf(".dfxp") !== -1) return true;
    return false;
  }

  /** 生成去重 key：忽略 query 中每次不同的 session token */
  function getUrlKey(url) {
    try {
      var parsed = new URL(url);
      return parsed.hostname + parsed.pathname;
    } catch (e) {
      return url;
    }
  }

  /* ========== 内容验证 ========== */

  /** 快速判断文本内容是否为 TTML/XML 格式 */
  function looksLikeTTML(text) {
    if (!text || typeof text !== "string" || text.length < 20) return false;
    var head = text.trimStart().slice(0, 400);
    return head.indexOf("<tt") !== -1 || (head.indexOf("<?xml") !== -1 && text.indexOf("<tt") !== -1);
  }

  /* ========== TTML 解析 ========== */

  /**
   * 解析 TTML 时间字符串为秒数
   * 支持格式：HH:MM:SS.mmm | HH:MM:SS,mmm | MM:SS.mmm | SS.mmm
   */
  function parseTimeToSeconds(raw) {
    if (!raw) return 0;
    var s = raw.trim().replace(",", ".");
    var parts = s.split(":");
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    if (parts.length === 2) {
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(s) || 0;
  }

  /**
   * 解析 TTML XML 为标准 cue 数组
   * @param {string} xmlText - TTML 文件内容
   * @returns {{startTime:number, endTime:number, text:string}[]}
   */
  function parseTTMLContent(xmlText) {
    var cues = [];
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(xmlText, "text/xml");

      // 检查 XML 解析错误
      if (doc.querySelector("parsererror")) return cues;

      var pNodes = doc.querySelectorAll("p");
      var seen = new Set();

      pNodes.forEach(function (p) {
        var begin = p.getAttribute("begin");
        var end = p.getAttribute("end");
        if (!begin || !end) return;

        var startTime = parseTimeToSeconds(begin);
        var endTime = parseTimeToSeconds(end);
        if (endTime <= startTime || startTime < 0) return;

        // 移除 ruby 注音标签（<rt>/<rp>），避免日语假名读音混入正文
        var clone = p.cloneNode(true);
        var rubyEls = clone.querySelectorAll("rt, rp");
        rubyEls.forEach(function (el) {
          if (el.parentNode) el.parentNode.removeChild(el);
        });

        var text = (clone.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) return;

        // 对同一 startTime + text 去重
        var dedupKey = startTime.toFixed(3) + "|" + text;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);

        cues.push({ startTime: startTime, endTime: endTime, text: text });
      });

      // 按开始时间升序排列
      cues.sort(function (a, b) {
        return a.startTime - b.startTime;
      });
    } catch (e) {
      // 解析失败时安全返回空数组
    }
    return cues;
  }

  /* ========== 字幕处理主逻辑 ========== */

  /**
   * 接收到字幕内容后的处理函数
   * 验证 → 去重 → 解析 → postMessage
   */
  function handleSubtitleText(url, text) {
    if (!looksLikeTTML(text)) return;

    var key = getUrlKey(url);
    if (_sentKeys.has(key)) return;
    _sentKeys.add(key);

    var cues = parseTTMLContent(text);
    if (!cues.length) return;

    // 发送给 isolated world 的 contentScript
    window.postMessage(
      {
        source: "subbridge-interceptor",
        type: "SUBBRIDGE_CUES",
        cues: cues,
        cueCount: cues.length,
        url: url,
      },
      "*",
    );
  }

  /* ========== Hook: window.fetch ========== */

  var _origFetch = window.fetch;

  window.fetch = async function () {
    // 提取 URL（兼容 string、URL 对象、Request 对象）
    var resource = arguments[0];
    var url = "";
    if (typeof resource === "string") {
      url = resource;
    } else if (resource && typeof resource.url === "string") {
      url = resource.url;
    }

    var resp = await _origFetch.apply(this, arguments);

    if (isSubtitleUrl(url)) {
      try {
        // clone 后异步读取，不阻塞原始响应
        var clone = resp.clone();
        clone.text().then(function (text) {
          handleSubtitleText(url, text);
        });
      } catch (e) {
        // 不影响正常请求流程
      }
    }

    return resp;
  };

  /* ========== Hook: XMLHttpRequest ========== */

  var _origOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function () {
    try {
      var url = String(arguments[1] || "");
      this._subbridgeUrl = url;
      this._subbridgeIsSubtitle = isSubtitleUrl(url);
    } catch (e) {}
    return _origOpen.apply(this, arguments);
  };

  var _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.send = function () {
    if (this._subbridgeIsSubtitle) {
      var self = this;
      this.addEventListener("load", function () {
        try {
          if (self.responseText) {
            handleSubtitleText(self._subbridgeUrl, self.responseText);
          }
        } catch (e) {}
      });
    }
    return _origSend.apply(this, arguments);
  };
})();
