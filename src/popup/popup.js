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

// 预翻译相关
const btnAutoExtract = document.getElementById("btnAutoExtract");
const fileInput = document.getElementById("fileInput");
const btnStopSync = document.getElementById("btnStopSync");
const btnExportSrt = document.getElementById("btnExportSrt");
const pretranslateStatus = document.getElementById("pretranslateStatus");
const pretranslateProgress = document.getElementById("pretranslateProgress");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");

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

/* ========== 预翻译功能 ========== */

function sendToContentScript(message) {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs[0]) {
        resolve({ ok: false, error: "no_tab" });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, message, function (resp) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false });
      });
    });
  });
}

function showStatus(msg) {
  pretranslateStatus.textContent = msg;
  pretranslateStatus.style.display = msg ? "block" : "none";
}

function showProgress(done, total, failed) {
  if (total <= 0) {
    pretranslateProgress.style.display = "none";
    return;
  }
  pretranslateProgress.style.display = "flex";
  var pct = Math.round((done / total) * 100);
  progressFill.style.width = pct + "%";
  var txt = done + "/" + total + " (" + pct + "%)";
  if (failed) txt += " 失败:" + failed;
  progressText.textContent = txt;
}

// 自动提取
btnAutoExtract.addEventListener("click", async function () {
  showStatus("正在通知页面提取字幕...");
  var resp = await sendToContentScript({ type: "PRETRANSLATE_AUTO" });
  if (resp && resp.ok) {
    showStatus("已发送提取请求，请在页面查看提示");
    startPollingStatus();
  } else {
    showStatus("请先打开 Netflix 视频页面");
  }
});

// 文件导入
fileInput.addEventListener("change", function () {
  var file = fileInput.files && fileInput.files[0];
  if (!file) return;

  var reader = new FileReader();
  reader.onload = async function () {
    var content = reader.result;
    showStatus("正在解析文件并开始翻译...");
    var resp = await sendToContentScript({
      type: "PRETRANSLATE_FILE",
      content: content,
      filename: file.name,
    });
    if (resp && resp.ok) {
      showStatus("文件已导入，开始批量翻译...");
      startPollingStatus();
    } else {
      showStatus("文件导入失败，请先打开 Netflix 视频页面");
    }
    fileInput.value = "";
  };
  reader.readAsText(file);
});

// 停止
btnStopSync.addEventListener("click", async function () {
  await sendToContentScript({ type: "PRETRANSLATE_STOP" });
  showStatus("已停止");
  btnStopSync.style.display = "none";
  btnExportSrt.style.display = "none";
  showProgress(0, 0, 0);
});

// 导出 SRT
btnExportSrt.addEventListener("click", async function () {
  var resp = await sendToContentScript({ type: "PRETRANSLATE_EXPORT" });
  if (resp && resp.srt) {
    var blob = new Blob([resp.srt], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "translated_subtitles.srt";
    a.click();
    URL.revokeObjectURL(url);
    showStatus("已导出");
  } else {
    showStatus("暂无翻译数据可导出");
  }
});

// 轮询状态
var pollTimer = null;

function startPollingStatus() {
  if (pollTimer) return;
  pollTimer = setInterval(pollStatus, 800);
  pollStatus();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollStatus() {
  var resp = await sendToContentScript({ type: "PRETRANSLATE_STATUS" });
  if (!resp) {
    stopPolling();
    return;
  }

  if (resp.active) {
    showStatus("预翻译模式已激活 ✓ 共 " + resp.cueCount + " 条");
    showProgress(0, 0, 0);
    btnStopSync.style.display = "inline-block";
    btnExportSrt.style.display = "inline-block";
    btnAutoExtract.disabled = true;
    stopPolling();
    return;
  }

  if (resp.translating) {
    var p = resp.progress || {};
    showProgress(p.done || 0, p.total || 0, p.failed || 0);
    btnStopSync.style.display = "inline-block";
    btnAutoExtract.disabled = true;
  } else {
    btnAutoExtract.disabled = false;
    if (resp.cueCount > 0) {
      showStatus("预翻译模式已激活 ✓ 共 " + resp.cueCount + " 条");
      btnStopSync.style.display = "inline-block";
      btnExportSrt.style.display = "inline-block";
      stopPolling();
    } else {
      stopPolling();
    }
  }
}

// 初始化时检查当前状态
async function initPretranslateUI() {
  var resp = await sendToContentScript({ type: "PRETRANSLATE_STATUS" });
  if (resp && resp.active) {
    showStatus("预翻译模式已激活 ✓ 共 " + resp.cueCount + " 条");
    btnStopSync.style.display = "inline-block";
    btnExportSrt.style.display = "inline-block";
    btnAutoExtract.disabled = true;
  } else if (resp && resp.translating) {
    startPollingStatus();
  }
}

void loadSettings();
void initPretranslateUI();
