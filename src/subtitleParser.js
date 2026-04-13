/**
 * SubBridge SRT/VTT 字幕解析器
 * 支持解析 .srt 和 .vtt 格式文件为统一的 cue 数组
 * 输出: [{startTime, endTime, text}]  (时间单位: 秒)
 */
(function () {
  "use strict";

  /* ========== 时间解析 ========== */

  /** 解析 "HH:MM:SS,mmm" 或 "HH:MM:SS.mmm" 或 "MM:SS.mmm" 为秒 */
  function parseTimestamp(raw) {
    if (!raw) return 0;
    var str = raw.trim().replace(",", ".");

    // MM:SS.mmm
    var short = str.match(/^(\d{1,2}):(\d{2})\.(\d{1,3})$/);
    if (short) {
      return Number(short[1]) * 60 + Number(short[2]) + Number(short[3].padEnd(3, "0")) / 1000;
    }

    // HH:MM:SS.mmm
    var full = str.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (full) {
      return Number(full[1]) * 3600 + Number(full[2]) * 60 + Number(full[3]) + (full[4] ? Number(full[4].padEnd(3, "0")) / 1000 : 0);
    }

    return 0;
  }

  /* ========== SRT 解析 ========== */

  function parseSRT(content) {
    var cues = [];
    // 标准化换行
    var text = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var blocks = text.split(/\n\n+/);

    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i].trim();
      if (!block) continue;

      var lines = block.split("\n");
      // 找到时间行（包含 " --> "）
      var timeLineIdx = -1;
      for (var j = 0; j < lines.length; j++) {
        if (lines[j].indexOf("-->") !== -1) {
          timeLineIdx = j;
          break;
        }
      }
      if (timeLineIdx === -1) continue;

      var timeParts = lines[timeLineIdx].split("-->");
      if (timeParts.length < 2) continue;

      var startTime = parseTimestamp(timeParts[0]);
      // 去掉 position 标记 (如 "00:01:23,456 --> 00:01:25,789 X1:... X2:...")
      var endRaw = timeParts[1].split(/\s+/)[0];
      var endTime = parseTimestamp(endRaw);

      // 剩余行为字幕文本
      var subtitleLines = [];
      for (var k = timeLineIdx + 1; k < lines.length; k++) {
        var line = lines[k].replace(/<[^>]+>/g, "").trim();
        if (line) subtitleLines.push(line);
      }

      if (subtitleLines.length && endTime > startTime) {
        cues.push({
          startTime: startTime,
          endTime: endTime,
          text: subtitleLines.join(" "),
        });
      }
    }

    return cues;
  }

  /* ========== VTT 解析 ========== */

  function parseVTT(content) {
    var cues = [];
    var text = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // 移除 WEBVTT 头部和 NOTE 块
    var blocks = text.split(/\n\n+/);
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i].trim();
      if (!block) continue;
      if (block.indexOf("WEBVTT") === 0) continue;
      if (block.indexOf("NOTE") === 0) continue;
      if (block.indexOf("STYLE") === 0) continue;

      var lines = block.split("\n");
      var timeLineIdx = -1;
      for (var j = 0; j < lines.length; j++) {
        if (lines[j].indexOf("-->") !== -1) {
          timeLineIdx = j;
          break;
        }
      }
      if (timeLineIdx === -1) continue;

      var timeParts = lines[timeLineIdx].split("-->");
      if (timeParts.length < 2) continue;

      var startTime = parseTimestamp(timeParts[0]);
      var endRaw = timeParts[1].split(/\s+/)[0];
      var endTime = parseTimestamp(endRaw);

      var subtitleLines = [];
      for (var k = timeLineIdx + 1; k < lines.length; k++) {
        var line = lines[k].replace(/<[^>]+>/g, "").trim();
        if (line) subtitleLines.push(line);
      }

      if (subtitleLines.length && endTime > startTime) {
        cues.push({
          startTime: startTime,
          endTime: endTime,
          text: subtitleLines.join(" "),
        });
      }
    }

    return cues;
  }

  /* ========== 自动检测格式并解析 ========== */

  function parseSubtitleFile(content, filename) {
    if (!content || typeof content !== "string") return [];

    var lower = (filename || "").toLowerCase();

    if (lower.endsWith(".vtt") || content.trimStart().indexOf("WEBVTT") === 0) {
      return parseVTT(content);
    }

    // 默认尝试 SRT
    return parseSRT(content);
  }

  /* ========== 从 video.textTracks 提取全部 cue ========== */

  function extractAllCuesFromVideo() {
    var video = document.querySelector("video");
    if (!video || !video.textTracks) {
      return { supported: false, cues: [], trackCount: 0 };
    }

    var allCues = [];
    var trackCount = video.textTracks.length;

    for (var i = 0; i < trackCount; i++) {
      var track = video.textTracks[i];
      try {
        if (track.mode === "disabled") {
          track.mode = "hidden";
        }
      } catch (e) {
        void e;
      }

      var cues = track.cues;
      if (!cues || !cues.length) continue;

      for (var j = 0; j < cues.length; j++) {
        var cue = cues[j];
        if (typeof cue.startTime !== "number" || typeof cue.endTime !== "number") continue;

        var raw = typeof cue.text === "string" ? cue.text : "";
        var text = raw
          .replace(/<[^>]+>/g, " ")
          .replace(/\n/g, " ")
          .trim();
        text = text.replace(/\s+/g, " ").trim();

        if (text && cue.endTime > cue.startTime) {
          allCues.push({
            startTime: cue.startTime,
            endTime: cue.endTime,
            text: text,
          });
        }
      }
    }

    // 按开始时间排序，去重
    allCues.sort(function (a, b) {
      return a.startTime - b.startTime || a.endTime - b.endTime;
    });

    var deduped = [];
    var seen = new Set();
    for (var k = 0; k < allCues.length; k++) {
      var key = allCues[k].startTime.toFixed(2) + "|" + allCues[k].text;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(allCues[k]);
      }
    }

    return { supported: true, cues: deduped, trackCount: trackCount };
  }

  /* ========== 公开接口 ========== */

  window.SubBridgeParser = {
    parseSRT: parseSRT,
    parseVTT: parseVTT,
    parseSubtitleFile: parseSubtitleFile,
    extractAllCuesFromVideo: extractAllCuesFromVideo,
  };
})();
