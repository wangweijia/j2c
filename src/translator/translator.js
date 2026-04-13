(function () {
  const cache = new Map();
  const CACHE_LIMIT = 500;

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

  function setCache(key, value) {
    if (cache.has(key)) {
      cache.delete(key);
    }
    cache.set(key, value);

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

  async function translateOnlineFree(text, lang) {
    const source = lang === "ja" ? "ja" : "en";
    const url = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(text) + "&langpair=" + source + "|zh-CN";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error("online_free_failed");
      }

      const data = await response.json();
      const translated = data && data.responseData && data.responseData.translatedText;

      if (!translated || typeof translated !== "string") {
        throw new Error("online_free_empty");
      }

      return translated;
    } finally {
      clearTimeout(timeout);
    }
  }

  function resolveLanguage(lang) {
    if (lang === "ja") return "ja";
    if (lang === "en") return "en";
    return "en";
  }

  async function translate(text, mode, preferredLang) {
    const normalized = normalizeText(text);
    if (!normalized) return "";

    const lang = resolveLanguage(preferredLang || detectLanguage(normalized));
    const cacheKey = mode + "::" + lang + "::" + normalized;

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

    if (mode === "online-free" && (lang === "en" || lang === "ja")) {
      try {
        translatedText = await translateOnlineFree(normalized, lang);
      } catch (error) {
        translatedText = getLocalTranslation(normalized, lang);
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
      provider: mode === "online-free" ? "online-free" : "local-free",
    };
  }

  window.SubBridgeTranslator = {
    detectLanguage,
    normalizeText,
    translate,
  };
})();
