(function () {
  /* ========== 缓存 ========== */
  const cache = new Map();
  const CACHE_LIMIT = 2000;
  let persistDirty = false;

  async function loadPersistentCache() {
    try {
      const data = await chrome.storage.local.get("subtitleCache");
      const entries = data && data.subtitleCache;
      if (Array.isArray(entries)) {
        entries.forEach(([k, v]) => {
          // 清理之前可能因为限流而被错误写入的回退缓存
          if (typeof v === "string" && v.indexOf("[本地") !== -1) {
            return;
          }
          cache.set(k, v);
        });
      }
    } catch (e) {
      void e;
    }
  }

  async function savePersistentCache() {
    if (!persistDirty) return;
    persistDirty = false;
    try {
      const entries = [...cache.entries()].slice(-CACHE_LIMIT);
      await chrome.storage.local.set({ subtitleCache: entries });
    } catch (e) {
      void e;
    }
  }

  setInterval(savePersistentCache, 15000);
  void loadPersistentCache();

  /* ========== 设置 ========== */
  let userEmail = "";

  async function loadTranslatorSettings() {
    try {
      const data = await chrome.storage.sync.get(["myMemoryEmail"]);
      userEmail = (data && data.myMemoryEmail) || "";
    } catch (e) {
      void e;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.myMemoryEmail) {
      userEmail = changes.myMemoryEmail.newValue || "";
    }
  });

  void loadTranslatorSettings();

  /* ========== 本地词典 ========== */
  const localDictionary = {
    en: {

    },
    ja: {

    },
  };

  /* ========== 工具函数 ========== */
  function detectLanguage(text) {
    if (!text) return "unknown";
    const jaRegex = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;
    const enRegex = /^[A-Za-z0-9\s.,!?"'\-:;()]+$/;
    if (jaRegex.test(text)) return "ja";
    if (enRegex.test(text)) return "en";
    return "unknown";
  }

  function normalizeText(text) {
    return (text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.!?;:])/g, "$1")
      .trim();
  }

  function makeFallbackLabel(lang) {
    if (lang === "ja") return "[本地日译中]";
    if (lang === "en") return "[本地英译中]";
    return "[本地回退]";
  }

  function resolveLanguage(lang) {
    if (lang === "ja") return "ja";
    if (lang === "en") return "en";
    return "en";
  }

  function setCache(key, value) {
    if (cache.has(key)) {
      cache.delete(key);
    }
    cache.set(key, value);
    persistDirty = true;
    if (cache.size > CACHE_LIMIT) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
  }

  function getLocalTranslation(text, lang) {
    const normalized = text.toLowerCase();
    const dict = localDictionary[lang] || {};
    if (dict[normalized]) {
      return dict[normalized];
    }
    return makeFallbackLabel(lang) + " " + text;
  }

  /* ========== 通用 fetch 工具 ========== */
  async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error("http_" + resp.status);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ========== 翻译源 1: MyMemory ========== */
  async function translateMyMemory(text, lang) {
    const source = lang === "ja" ? "ja" : "en";
    let url = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(text) + "&langpair=" + source + "|zh-CN";
    if (userEmail) {
      url += "&de=" + encodeURIComponent(userEmail);
    }
    const data = await fetchWithTimeout(url, 2500);
    const t = data && data.responseData && data.responseData.translatedText;
    if (!t || typeof t !== "string") throw new Error("mymemory_empty");
    return t;
  }

  /* ========== 翻译源 2: Google Translate 非官方端点 ========== */
  async function translateGoogle(text, lang) {
    const source = lang === "ja" ? "ja" : "en";
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" +
      source +
      "&tl=zh-CN&dt=t&q=" +
      encodeURIComponent(text);
    const data = await fetchWithTimeout(url, 3000);
    // 返回格式: [[["翻译结果", "原文", ...], ...], ...]
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("google_empty");
    const parts = data[0]
      .filter((item) => Array.isArray(item) && typeof item[0] === "string")
      .map((item) => item[0]);
    const t = parts.join("");
    if (!t) throw new Error("google_empty");
    return t;
  }

  /* ========== 链式翻译策略 ========== */
  let apiBlockedUntil = 0;

  async function translateOnlineChain(text, lang) {
    if (Date.now() < apiBlockedUntil) {
      throw new Error("api_rate_limited");
    }

    const strategies = [translateMyMemory, translateGoogle];
    let lastError = null;
    for (const fn of strategies) {
      try {
        return await fn(text, lang);
      } catch (e) {
        lastError = e;
      }
    }

    // 如果所有策略都失败（通常是因为触发了限流），则设置一个60秒的冷却期
    apiBlockedUntil = Date.now() + 60000;
    throw lastError || new Error("all_sources_failed");
  }

  /* ========== 主入口 ========== */
  async function translate(text, mode, preferredLang) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return { lang: "unknown", translatedText: "", originalText: "", fromCache: false, provider: "none" };
    }

    const lang = resolveLanguage(preferredLang || detectLanguage(normalized));
    const cacheKey = lang + "::" + normalized;

    if (cache.has(cacheKey)) {
      return {
        lang,
        translatedText: cache.get(cacheKey),
        originalText: normalized,
        fromCache: true,
        provider: "cache",
      };
    }

    let translatedText = normalized;
    let provider = "local-free";

    if (mode === "online-free" && (lang === "en" || lang === "ja")) {
      try {
        translatedText = await translateOnlineChain(normalized, lang);
        provider = "online-free";
        setCache(cacheKey, translatedText);
      } catch (error) {
        translatedText = getLocalTranslation(normalized, lang);
        provider = "local-fallback";
        // 避免在触发限流时，将失败的回退结果写入缓存，导致后续无法重试
      }
    } else {
      translatedText = getLocalTranslation(normalized, lang);
    }

    return {
      lang,
      translatedText,
      originalText: normalized,
      fromCache: false,
      provider,
    };
  }

  function isCached(text, preferredLang) {
    const normalized = normalizeText(text);
    if (!normalized) return true; // Treat empty as cached to avoid fetching

    const lang = resolveLanguage(preferredLang || detectLanguage(normalized));
    const cacheKey = lang + "::" + normalized;

    return cache.has(cacheKey);
  }

  window.SubBridgeTranslator = {
    detectLanguage,
    normalizeText,
    translate,
    isCached,
  };
})();
