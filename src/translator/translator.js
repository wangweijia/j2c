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
        entries.forEach(([k, v]) => cache.set(k, v));
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
      "thank you": "谢谢",
      "i love you": "我爱你",
      "what happened": "发生了什么",
      "hurry up": "快点",
      "be careful": "小心",
      "no way": "不可能",
      "wait a second": "等一下",
      "let's go": "我们走吧",
      "i don't know": "我不知道",
      "are you okay": "你还好吗",
      "see you": "回头见",
    },
    ja: {
      ありがとう: "谢谢",
      ごめん: "对不起",
      大丈夫: "没事",
      おはよう: "早上好",
      こんばんは: "晚上好",
      お願いします: "拜托了",
      ちょっと待って: "等一下",
      どうしたの: "怎么了",
      いってきます: "我出门了",
      ただいま: "我回来了",
      信じられない: "难以置信",
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

  /* ========== 翻译源 2: Lingva (Google 翻译代理) ========== */
  async function translateLingva(text, lang) {
    const source = lang === "ja" ? "ja" : "en";
    const url = "https://lingva.ml/api/v1/" + source + "/zh/" + encodeURIComponent(text);
    const data = await fetchWithTimeout(url, 3000);
    const t = data && data.translation;
    if (!t || typeof t !== "string") throw new Error("lingva_empty");
    return t;
  }

  /* ========== 翻译源 3: LibreTranslate 公共实例 ========== */
  async function translateLibre(text, lang) {
    const source = lang === "ja" ? "ja" : "en";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const resp = await fetch("https://libretranslate.com/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: text, source, target: "zh", format: "text" }),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error("libre_http_" + resp.status);
      const data = await resp.json();
      const t = data && data.translatedText;
      if (!t || typeof t !== "string") throw new Error("libre_empty");
      return t;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ========== 链式翻译策略 ========== */
  async function translateOnlineChain(text, lang) {
    const strategies = [translateMyMemory, translateLingva, translateLibre];
    let lastError = null;
    for (const fn of strategies) {
      try {
        return await fn(text, lang);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("all_sources_failed");
  }

  /* ========== 主入口 ========== */
  async function translate(text, mode, preferredLang) {
    const normalized = normalizeText(text);
    if (!normalized) return "";

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
      } catch (error) {
        translatedText = getLocalTranslation(normalized, lang);
        provider = "local-fallback";
      }
    } else {
      translatedText = getLocalTranslation(normalized, lang);
    }

    setCache(cacheKey, translatedText);

    return {
      lang,
      translatedText,
      originalText: normalized,
      fromCache: false,
      provider,
    };
  }

  window.SubBridgeTranslator = {
    detectLanguage,
    normalizeText,
    translate,
  };
})();
