"use strict";

const { buildMarketSentiment } = require("./marketSentiment.service");

const MARKET_SENTIMENT_FRESHNESS_WEIGHT = 0.6;
const MARKET_SENTIMENT_SOURCE_QUALITY_WEIGHT = 0.4;

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value, maxLength = 10000) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  return text.slice(0, maxLength);
}

function uniqueStrings(values = [], maxItems = 100) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(text);

    if (result.length >= maxItems) break;
  }

  return result;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeDirection(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["bullish", "positive", "up"].includes(normalized)) return "bullish";
  if (["bearish", "negative", "down"].includes(normalized)) return "bearish";
  return "neutral";
}

function buildNewsTextBlob(article = {}) {
  return normalizeText(
    [
      article?.title,
      article?.summaryRaw,
      article?.summary,
      article?.source,
      article?.url,
    ]
      .filter(Boolean)
      .join(" "),
    20000
  );
}

function scorePhraseMatches(textBlobLower, phrases = [], weight = 1) {
  let score = 0;
  const matches = [];

  for (const phrase of phrases) {
    const normalized = String(phrase || "").trim().toLowerCase();
    if (!normalized || normalized.length < 2) continue;

    if (textBlobLower.includes(normalized)) {
      score += weight;
      matches.push(phrase);
    }
  }

  return { score, matches };
}

function scoreWeightedPhraseMatches(textBlobLower, weightedPhrases = []) {
  let score = 0;
  const matches = [];

  for (const entry of weightedPhrases) {
    const phrase =
      typeof entry === "string"
        ? entry
        : String(entry?.phrase || "").trim();
    const weight =
      typeof entry === "string" ? 1 : safeNumber(entry?.weight, 1);
    const normalized = phrase.toLowerCase();

    if (!normalized || normalized.length < 2) continue;

    if (textBlobLower.includes(normalized)) {
      score += weight;
      matches.push(phrase);
    }
  }

  return { score, matches: uniqueStrings(matches, 20) };
}

function inferDirectionalBias(textBlobLower) {
  const bullish = scoreWeightedPhraseMatches(textBlobLower, [
    { phrase: "beats expectations", weight: 4 },
    { phrase: "beat expectations", weight: 4 },
    { phrase: "raises guidance", weight: 4 },
    { phrase: "raises outlook", weight: 4 },
    { phrase: "record revenue", weight: 4 },
    { phrase: "strong demand", weight: 3 },
    { phrase: "above estimates", weight: 3 },
    { phrase: "tops estimates", weight: 3 },
    { phrase: "profit rises", weight: 3 },
    { phrase: "surge", weight: 2 },
    { phrase: "jump", weight: 2 },
    { phrase: "buyback", weight: 2 },
    { phrase: "dividend increase", weight: 2 },
    { phrase: "upgrade", weight: 2 },
  ]).score;

  const bearish = scoreWeightedPhraseMatches(textBlobLower, [
    { phrase: "misses expectations", weight: 4 },
    { phrase: "missed expectations", weight: 4 },
    { phrase: "cuts guidance", weight: 4 },
    { phrase: "cuts outlook", weight: 4 },
    { phrase: "below estimates", weight: 3 },
    { phrase: "weak demand", weight: 3 },
    { phrase: "profit warning", weight: 3 },
    { phrase: "downgrade", weight: 2 },
    { phrase: "lawsuit", weight: 2 },
    { phrase: "probe", weight: 2 },
    { phrase: "investigation", weight: 2 },
    { phrase: "decline", weight: 2 },
    { phrase: "drop", weight: 2 },
    { phrase: "fall", weight: 2 },
  ]).score;

  if (bullish >= bearish + 2) return "bullish";
  if (bearish >= bullish + 2) return "bearish";
  return "neutral";
}

function scoreEntityMatch(article = {}, entity = {}) {
  const symbol = normalizeSymbol(entity?.symbol);
  const companyName = normalizeText(entity?.companyName || entity?.company_name, 255);
  const aliases = Array.isArray(entity?.aliases) ? entity.aliases : [];
  const themes = Array.isArray(entity?.themes) ? entity.themes : [];

  const textBlob = buildNewsTextBlob(article);
  const textBlobLower = textBlob.toLowerCase();

  let score = 0;
  const reasons = [];

  const titleLower = normalizeText(article?.title, 2000).toLowerCase();
  const summaryLower = normalizeText(
    article?.summaryRaw || article?.summary,
    4000
  ).toLowerCase();

  if (symbol && titleLower.includes(symbol.toLowerCase())) {
    score += 18;
    reasons.push(`Symbol ${symbol} im Titel`);
  } else if (symbol && summaryLower.includes(symbol.toLowerCase())) {
    score += 10;
    reasons.push(`Symbol ${symbol} im Text`);
  }

  if (companyName) {
    if (titleLower.includes(companyName.toLowerCase())) {
      score += 28;
      reasons.push(`Firmenname "${companyName}" im Titel`);
    } else if (summaryLower.includes(companyName.toLowerCase())) {
      score += 16;
      reasons.push(`Firmenname "${companyName}" im Text`);
    }
  }

  const aliasScore = scorePhraseMatches(textBlobLower, aliases, 8);
  if (aliasScore.score > 0) {
    score += aliasScore.score;
    reasons.push(
      `Alias-Treffer: ${aliasScore.matches.slice(0, 3).join(", ")}`
    );
  }

  const themeScore = scorePhraseMatches(textBlobLower, themes, 3);
  if (themeScore.score > 0) {
    score += Math.min(themeScore.score, 12);
    reasons.push(
      `Themen-Treffer: ${themeScore.matches.slice(0, 3).join(", ")}`
    );
  }

  if (
    article?.entityHint &&
    normalizeSymbol(article.entityHint.symbol) === symbol &&
    safeNumber(article.entityHint.matchScore, 0) > 0
  ) {
    const hintScore = clamp(
      safeNumber(article.entityHint.matchScore, 0) * 2,
      0,
      25
    );
    score += hintScore;
    reasons.push(`Entity-Hint MatchScore ${article.entityHint.matchScore}`);
  }

  return {
    symbol,
    score: clamp(Math.round(score), 0, 100),
    reasons: uniqueStrings(reasons, 10),
  };
}

function collectEntityMatches(article = {}, entityMapBySymbol = {}) {
  const results = [];

  for (const [symbol, entity] of Object.entries(entityMapBySymbol || {})) {
    const match = scoreEntityMatch(article, {
      ...entity,
      symbol,
    });

    if (match.score <= 0) continue;

    results.push({
      symbol,
      companyName: entity?.companyName || null,
      sector: entity?.sector || null,
      industry: entity?.industry || null,
      themes: Array.isArray(entity?.themes) ? entity.themes : [],
      countries: Array.isArray(entity?.countries) ? entity.countries : [],
      commodities: Array.isArray(entity?.commodities) ? entity.commodities : [],
      aliases: Array.isArray(entity?.aliases) ? entity.aliases : [],
      matchScore: match.score,
      matchReasons: match.reasons,
    });
  }

  return results.sort((a, b) => b.matchScore - a.matchScore);
}

function classifyEvent(article = {}, matchedEntities = []) {
  const text = buildNewsTextBlob(article).toLowerCase();
  const titleText = normalizeText(article?.title, 2000).toLowerCase();

  const rules = [
    {
      eventType: "earnings",
      direction: "neutral",
      horizon: "short_term",
      weight: 22,
      patterns: [
        "earnings",
        "quarterly results",
        "q1 results",
        "q2 results",
        "q3 results",
        "q4 results",
        "results",
        "revenue",
        "eps",
        "sales",
        "profit",
        "operating margin",
        "beats expectations",
        "beat expectations",
        "misses expectations",
        "missed expectations",
        "above estimates",
        "below estimates",
      ],
    },
    {
      eventType: "guidance",
      direction: "neutral",
      horizon: "short_term",
      weight: 20,
      patterns: [
        "guidance",
        "outlook",
        "forecast",
        "raises forecast",
        "cuts forecast",
        "raises outlook",
        "cuts outlook",
        "reaffirms",
        "expects",
        "sees fy",
      ],
    },
    {
      eventType: "merger_acquisition",
      direction: "neutral",
      horizon: "medium_term",
      weight: 24,
      patterns: [
        "acquire",
        "acquisition",
        "merger",
        "buyout",
        "takeover",
        "deal to buy",
        "take private",
        "strategic alternatives",
        "all-stock deal",
        "cash deal",
      ],
    },
    {
      eventType: "analyst_action",
      direction: "neutral",
      horizon: "short_term",
      weight: 16,
      patterns: [
        "upgraded",
        "downgraded",
        "price target",
        "analyst",
        "buy rating",
        "sell rating",
        "overweight",
        "underweight",
        "initiated",
        "raised to buy",
        "cut to sell",
      ],
    },
    {
      eventType: "product_launch",
      direction: "bullish",
      horizon: "medium_term",
      weight: 16,
      patterns: [
        "launches",
        "launch",
        "introduces",
        "announces new",
        "rolls out",
        "unveils",
        "debut",
        "release",
        "new platform",
      ],
    },
    {
      eventType: "regulation",
      direction: "neutral",
      horizon: "medium_term",
      weight: 20,
      patterns: [
        "regulator",
        "regulation",
        "antitrust",
        "investigation",
        "probe",
        "lawsuit",
        "fine",
        "ban",
        "sec",
        "fda",
        "department of justice",
        "doj",
        "settlement",
      ],
    },
    {
      eventType: "insider_management",
      direction: "neutral",
      horizon: "short_term",
      weight: 18,
      patterns: [
        "ceo",
        "cfo",
        "executive",
        "resigns",
        "steps down",
        "appointed",
        "insider",
        "chairman",
        "board",
        "director",
      ],
    },
    {
      eventType: "macro_rate",
      direction: "neutral",
      horizon: "short_term",
      weight: 18,
      patterns: [
        "fed",
        "interest rate",
        "rate cut",
        "rate hike",
        "central bank",
        "treasury yields",
        "federal reserve",
        "fomc",
        "treasury yield",
        "bond yields",
        "10-year yield",
      ],
    },
    {
      eventType: "macro_inflation",
      direction: "neutral",
      horizon: "short_term",
      weight: 18,
      patterns: [
        "inflation",
        "cpi",
        "ppi",
        "consumer prices",
        "producer prices",
        "pce",
        "core inflation",
        "disinflation",
      ],
    },
    {
      eventType: "supply_chain",
      direction: "neutral",
      horizon: "medium_term",
      weight: 18,
      patterns: [
        "supply chain",
        "shipment",
        "production",
        "factory",
        "plant",
        "shortage",
        "logistics",
        "backlog",
        "capacity",
      ],
    },
    {
      eventType: "sector_rotation",
      direction: "neutral",
      horizon: "short_term",
      weight: 14,
      patterns: [
        "sector",
        "rotation",
        "cyclical",
        "defensive",
        "broad market",
        "risk-on",
        "risk off",
      ],
    },
    {
      eventType: "geopolitical",
      direction: "neutral",
      horizon: "medium_term",
      weight: 18,
      patterns: [
        "tariff",
        "sanctions",
        "war",
        "conflict",
        "china",
        "taiwan",
        "middle east",
        "trade war",
        "export restrictions",
        "red sea",
      ],
    },
    {
      eventType: "dividend_buyback",
      direction: "bullish",
      horizon: "medium_term",
      weight: 16,
      patterns: [
        "dividend",
        "buyback",
        "share repurchase",
        "capital return",
        "dividend increase",
        "special dividend",
        "authorized repurchase",
      ],
    },
  ];

  let best = {
    eventType: "general_news",
    direction: "neutral",
    horizon: "short_term",
    score: 8,
    matchedPatterns: [],
  };

  for (const rule of rules) {
    const matchedPatterns = uniqueStrings(
      rule.patterns.filter((pattern) => text.includes(pattern.toLowerCase())),
      12
    );

    if (!matchedPatterns.length) continue;

    const titleMatches = matchedPatterns.filter((pattern) =>
      titleText.includes(pattern.toLowerCase())
    );
    const score =
      rule.weight + matchedPatterns.length * 3 + titleMatches.length * 4;
    if (score > best.score) {
      best = {
        eventType: rule.eventType,
        direction: rule.direction,
        horizon: rule.horizon,
        score,
        matchedPatterns,
      };
    }
  }

  if (matchedEntities.length > 0 && best.eventType === "general_news") {
    best.score += 8;
  }

  const inferredDirection =
    best.direction === "neutral" ? inferDirectionalBias(text) : best.direction;

  return {
    eventType: best.eventType,
    direction: normalizeDirection(inferredDirection),
    horizon: best.horizon,
    eventStrength: clamp(best.score, 0, 100),
    matchedPatterns: uniqueStrings(best.matchedPatterns, 10),
  };
}

function detectSentiment(article = {}) {
  const text = buildNewsTextBlob(article).toLowerCase();

  const bullish = scoreWeightedPhraseMatches(text, [
    { phrase: "beats expectations", weight: 5 },
    { phrase: "beat expectations", weight: 5 },
    { phrase: "raises guidance", weight: 5 },
    { phrase: "raises outlook", weight: 5 },
    { phrase: "record revenue", weight: 4 },
    { phrase: "record profit", weight: 4 },
    { phrase: "strong demand", weight: 3 },
    { phrase: "above estimates", weight: 3 },
    { phrase: "tops estimates", weight: 3 },
    { phrase: "profit rises", weight: 3 },
    { phrase: "surge", weight: 2 },
    { phrase: "jump", weight: 2 },
    { phrase: "growth", weight: 2 },
    { phrase: "upgrade", weight: 2 },
    { phrase: "buyback", weight: 2 },
    { phrase: "dividend increase", weight: 2 },
  ]).score;

  const bearish = scoreWeightedPhraseMatches(text, [
    { phrase: "misses expectations", weight: 5 },
    { phrase: "missed expectations", weight: 5 },
    { phrase: "cuts guidance", weight: 5 },
    { phrase: "cuts outlook", weight: 5 },
    { phrase: "weak demand", weight: 3 },
    { phrase: "below estimates", weight: 3 },
    { phrase: "profit warning", weight: 3 },
    { phrase: "warning", weight: 2 },
    { phrase: "downgrade", weight: 2 },
    { phrase: "lawsuit", weight: 2 },
    { phrase: "probe", weight: 2 },
    { phrase: "investigation", weight: 2 },
    { phrase: "decline", weight: 2 },
    { phrase: "drop", weight: 2 },
    { phrase: "fall", weight: 2 },
    { phrase: "slump", weight: 2 },
  ]).score;

  const totalSignals = bullish + bearish;
  const margin = Math.abs(bullish - bearish);

  if (bullish > bearish && margin >= 2) {
    return {
      direction: "bullish",
      sentimentStrength: clamp(54 + margin * 6 + Math.min(totalSignals, 6) * 2, 0, 100),
    };
  }

  if (bearish > bullish && margin >= 2) {
    return {
      direction: "bearish",
      sentimentStrength: clamp(54 + margin * 6 + Math.min(totalSignals, 6) * 2, 0, 100),
    };
  }

  return {
    direction: "neutral",
    sentimentStrength: 50,
  };
}

function computeFreshnessScore(article = {}) {
  if (!article?.publishedAt) return 40;

  const publishedAt = new Date(article.publishedAt).getTime();
  if (!Number.isFinite(publishedAt)) return 40;

  const ageHours = Math.max(0, (Date.now() - publishedAt) / (1000 * 60 * 60));

  if (ageHours <= 2) return 100;
  if (ageHours <= 6) return 88;
  if (ageHours <= 12) return 76;
  if (ageHours <= 24) return 64;
  if (ageHours <= 48) return 48;
  if (ageHours <= 96) return 34;
  return 20;
}

function computeSourceQualityScore(article = {}) {
  const source = String(article?.source || "").trim().toLowerCase();

  const strong = [
    "reuters",
    "bloomberg",
    "wall street journal",
    "financial times",
    "cnbc",
    "marketwatch",
    "seeking alpha",
    "yahoo finance",
  ];

  const medium = [
    "google news rss",
    "benzinga",
    "investing.com",
    "business insider",
    "the motley fool",
  ];

  if (strong.some((item) => source.includes(item))) return 88;
  if (medium.some((item) => source.includes(item))) return 68;
  if (!source) return 50;

  return 58;
}

function normalizeRetentionClass(value) {
  const retentionClass = String(value || "").trim().toLowerCase();
  if (["short", "standard", "extended"].includes(retentionClass)) {
    return retentionClass;
  }
  return "standard";
}

function normalizeLifecycleState(value) {
  const lifecycleState = String(value || "").trim().toLowerCase();
  if (["active", "cooling", "expired"].includes(lifecycleState)) {
    return lifecycleState;
  }
  return "active";
}

function textHasLowSignalHint(article = {}) {
  const text = normalizeText(
    [
      article?.title,
      article?.summaryRaw,
      article?.summary,
      article?.category,
      article?.sentimentRaw,
    ]
      .filter(Boolean)
      .join(" "),
    4000
  ).toLowerCase();

  if (!text) return false;

  return [
    "rumor",
    "rumour",
    "speculation",
    "speculative",
    "unconfirmed",
    "market chatter",
    "brief update",
  ].some((phrase) => text.includes(phrase));
}

function computeLifecyclePersistenceScore(article = {}, intelligence = {}) {
  const eventType = String(intelligence?.eventType || "general_news").trim().toLowerCase();
  const relevanceScore = clamp(safeNumber(intelligence?.relevanceScore, 0), 0, 100);
  const confidence = clamp(safeNumber(intelligence?.confidence, 0), 0, 100);
  const sourceQuality = clamp(safeNumber(intelligence?.sourceQuality, 50), 0, 100);
  const freshnessScore = clamp(safeNumber(intelligence?.freshnessScore, 40), 0, 100);
  const marketImpactScore = clamp(safeNumber(intelligence?.marketImpactScore, 0), 0, 100);
  const direction = normalizeDirection(intelligence?.direction);

  const eventWeights = {
    earnings: 40,
    guidance: 36,
    merger_acquisition: 42,
    regulation: 34,
    dividend_buyback: 36,
    macro_rate: 30,
    macro_inflation: 30,
    geopolitical: 30,
    supply_chain: 24,
    product_launch: 24,
    sector_rotation: 22,
    insider_management: 20,
    analyst_action: 16,
    general_news: 8,
  };

  const durableEvents = new Set([
    "earnings",
    "guidance",
    "merger_acquisition",
    "regulation",
    "dividend_buyback",
    "macro_rate",
    "macro_inflation",
    "geopolitical",
    "supply_chain",
  ]);

  let score =
    safeNumber(eventWeights[eventType], eventWeights.general_news) +
    relevanceScore * 0.46 +
    confidence * 0.24 +
    sourceQuality * 0.14 +
    freshnessScore * 0.06 +
    marketImpactScore * 0.12;

  if (direction !== "neutral") {
    score += 4;
  }

  if (durableEvents.has(eventType) && (relevanceScore >= 70 || marketImpactScore >= 70)) {
    score += 10;
  }

  if (relevanceScore < 35) {
    score -= 12;
  }

  if (confidence < 35) {
    score -= 12;
  }

  if (sourceQuality < 55) {
    score -= 6;
  }

  if (textHasLowSignalHint(article)) {
    score -= 12;
  }

  if (eventType === "general_news" && confidence < 55) {
    score -= 8;
  }

  return clamp(Math.round(score), 0, 160);
}

function classifyNewsRetention(article = {}, intelligence = {}) {
  const eventType = String(intelligence?.eventType || "general_news").trim().toLowerCase();
  const relevanceScore = clamp(safeNumber(intelligence?.relevanceScore, 0), 0, 100);
  const confidence = clamp(safeNumber(intelligence?.confidence, 0), 0, 100);
  const persistenceScore = computeLifecyclePersistenceScore(article, intelligence);

  if (
    persistenceScore >= 108 ||
    (
      ["earnings", "guidance", "merger_acquisition", "regulation", "dividend_buyback"].includes(eventType) &&
      relevanceScore >= 68 &&
      confidence >= 55
    ) ||
    (
      ["macro_rate", "macro_inflation", "geopolitical", "supply_chain"].includes(eventType) &&
      relevanceScore >= 74
    )
  ) {
    return "extended";
  }

  if (
    persistenceScore >= 64 ||
    (
      ["earnings", "guidance", "regulation", "product_launch", "sector_rotation", "analyst_action"].includes(eventType) &&
      relevanceScore >= 45
    )
  ) {
    return "standard";
  }

  return "short";
}

function buildRetentionDurationDays(retentionClass, article = {}, intelligence = {}) {
  const normalizedRetentionClass = normalizeRetentionClass(retentionClass);
  const eventType = String(intelligence?.eventType || "general_news").trim().toLowerCase();
  const relevanceScore = clamp(safeNumber(intelligence?.relevanceScore, 0), 0, 100);
  const confidence = clamp(safeNumber(intelligence?.confidence, 0), 0, 100);
  const marketImpactScore = clamp(safeNumber(intelligence?.marketImpactScore, 0), 0, 100);
  const persistenceScore = computeLifecyclePersistenceScore(article, intelligence);

  if (normalizedRetentionClass === "extended") {
    let days = 24;
    if (relevanceScore >= 82) days += 7;
    if (confidence >= 76) days += 4;
    if (marketImpactScore >= 76) days += 5;
    if (["earnings", "guidance", "merger_acquisition", "regulation", "dividend_buyback"].includes(eventType)) {
      days += 5;
    }
    return clamp(days, 24, 45);
  }

  if (normalizedRetentionClass === "standard") {
    let days = 10;
    if (relevanceScore >= 70) days += 4;
    if (confidence >= 65) days += 2;
    if (marketImpactScore >= 68) days += 3;
    if (["earnings", "guidance", "regulation", "product_launch", "sector_rotation"].includes(eventType)) {
      days += 2;
    }
    if (persistenceScore >= 92) days += 2;
    return clamp(days, 10, 21);
  }

  let days = 3;
  if (relevanceScore >= 50) days += 1;
  if (confidence >= 50) days += 1;
  if (marketImpactScore >= 55) days += 1;
  if (eventType === "analyst_action") days += 1;
  return clamp(days, 2, 7);
}

function getCoolingWindowMs(retentionClass) {
  const normalizedRetentionClass = normalizeRetentionClass(retentionClass);

  if (normalizedRetentionClass === "extended") {
    return 7 * 24 * 60 * 60 * 1000;
  }

  if (normalizedRetentionClass === "standard") {
    return 3 * 24 * 60 * 60 * 1000;
  }

  return 24 * 60 * 60 * 1000;
}

function buildNewsLifecycle(article = {}, intelligence = {}) {
  const retentionClass = normalizeRetentionClass(
    article?.retentionClass ?? article?.retention_class
  );
  const publishedAtRaw = article?.publishedAt ?? article?.published_at ?? new Date().toISOString();
  const publishedAt = new Date(publishedAtRaw);
  const effectivePublishedAt = Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt;

  const computedRetentionClass =
    retentionClass === "standard" && !(article?.retentionClass ?? article?.retention_class)
      ? classifyNewsRetention(article, intelligence)
      : retentionClass;

  const daysToRetain = buildRetentionDurationDays(
    computedRetentionClass,
    article,
    intelligence
  );

  const expiresAt = article?.expiresAt ?? article?.expires_at
    ? new Date(article?.expiresAt ?? article?.expires_at)
    : new Date(effectivePublishedAt.getTime() + daysToRetain * 24 * 60 * 60 * 1000);

  const effectiveExpiresAt = Number.isNaN(expiresAt.getTime())
    ? new Date(effectivePublishedAt.getTime() + daysToRetain * 24 * 60 * 60 * 1000)
    : expiresAt;

  const now = Date.now();
  const expiresMs = effectiveExpiresAt.getTime();
  const timeUntilExpiry = expiresMs - now;
  const coolingWindowMs = getCoolingWindowMs(computedRetentionClass);

  let lifecycleState = "active";
  let isActiveForScoring = true;

  if (expiresMs <= now) {
    lifecycleState = "expired";
    isActiveForScoring = false;
  } else if (timeUntilExpiry <= coolingWindowMs) {
    lifecycleState = "cooling";
    isActiveForScoring = false;
  }

  const explicitLifecycleState = normalizeLifecycleState(
    article?.lifecycleState ?? article?.lifecycle_state
  );
  const explicitActiveForScoring =
    typeof article?.isActiveForScoring === "boolean"
      ? article.isActiveForScoring
      : typeof article?.is_active_for_scoring === "boolean"
        ? article.is_active_for_scoring
        : null;

  if (explicitLifecycleState === "expired") {
    lifecycleState = "expired";
    isActiveForScoring = false;
  } else if (explicitLifecycleState === "cooling" && lifecycleState !== "expired") {
    lifecycleState = "cooling";
    isActiveForScoring = false;
  }

  if (explicitActiveForScoring === false) {
    isActiveForScoring = false;
    if (lifecycleState === "active" && timeUntilExpiry <= coolingWindowMs) {
      lifecycleState = "cooling";
    }
  }

  return {
    retentionClass: computedRetentionClass,
    expiresAt: effectiveExpiresAt.toISOString(),
    isActiveForScoring,
    lifecycleState,
    daysToRetain,
    persistenceScore: computeLifecyclePersistenceScore(article, intelligence),
  };
}

function buildEmbeddedMarketSentiment({
  article = {},
  sentimentInfo = {},
  freshnessScore = 40,
  sourceQuality = 50,
  matchCount = 0,
}) {
  const direction = normalizeDirection(sentimentInfo?.direction);
  const sentimentStrength = clamp(
    safeNumber(sentimentInfo?.sentimentStrength, direction === "neutral" ? 0 : 50),
    0,
    100
  );
  const sentimentScore =
    direction === "bullish"
      ? sentimentStrength
      : direction === "bearish"
        ? -sentimentStrength
        : 0;
  const mentionCount = Math.max(1, safeNumber(matchCount, 0));
  const buzzScore = clamp(
    Math.round(
      freshnessScore * MARKET_SENTIMENT_FRESHNESS_WEIGHT +
        sourceQuality * MARKET_SENTIMENT_SOURCE_QUALITY_WEIGHT
    ),
    0,
    100
  );
  const reasons = uniqueStrings(
    [
      direction === "neutral"
        ? "News-Sentiment neutral aus Artikelinhalt abgeleitet"
        : `News-Sentiment ${direction} aus Artikelinhalt abgeleitet`,
      `Buzz-Score aus Freshness ${freshnessScore} und SourceQuality ${sourceQuality}`,
      article?.title ? `Titel berücksichtigt: ${normalizeText(article.title, 160)}` : null,
    ],
    6
  );

  const input = {
    sentimentScore,
    buzzScore,
    mentionCount,
    reasons,
  };

  if (article?.source) {
    input.sources = [
      {
        sourceName: article.source,
        sentimentScore,
        buzzScore,
        mentionCount,
        reasons,
      },
    ];
  }

  return buildMarketSentiment(input);
}

function aggregateSectors(matches = []) {
  return uniqueStrings(
    matches
      .map((item) => item?.sector)
      .filter(Boolean),
    20
  );
}

function aggregateThemes(matches = []) {
  const values = [];
  for (const item of matches) {
    for (const theme of Array.isArray(item?.themes) ? item.themes : []) {
      values.push(theme);
    }
  }
  return uniqueStrings(values, 30);
}

function aggregateIndustries(matches = []) {
  return uniqueStrings(
    matches
      .map((item) => item?.industry)
      .filter(Boolean),
    20
  );
}

/* =========================================================
MACRO EVENT DETECTION
========================================================= */

function detectMacroSignals(article = {}) {
  const text = buildNewsTextBlob(article).toLowerCase();
  const titleText = normalizeText(article?.title, 2000).toLowerCase();

  const macroSignals = [];

  const rules = [
    {
      type: "interest_rates",
      patterns: [
        "fed",
        "federal reserve",
        "interest rate",
        "rate hike",
        "rate cut",
        "central bank",
        "fomc",
        "treasury yield",
        "10-year yield",
      ],
    },
    {
      type: "inflation",
      patterns: [
        "inflation",
        "cpi",
        "ppi",
        "consumer price",
        "pce",
        "core inflation",
        "price pressures",
      ],
    },
    {
      type: "oil",
      patterns: ["oil", "crude", "opec", "brent", "wti", "barrel"],
    },
    {
      type: "ai",
      patterns: [
        "artificial intelligence",
        "generative ai",
        "ai chips",
        "ai boom",
        "llm",
        "data center demand",
      ],
    },
    {
      type: "semiconductors",
      patterns: [
        "semiconductor",
        "chips",
        "tsmc",
        "nvidia",
        "gpu",
        "foundry",
      ],
    },
    {
      type: "banking",
      patterns: [
        "banking crisis",
        "bank collapse",
        "liquidity",
        "regional bank",
        "deposit flight",
        "capital ratios",
      ],
    },
  ];

  for (const rule of rules) {
    const matches = uniqueStrings(
      rule.patterns.filter((pattern) => text.includes(pattern)),
      12
    );
    if (matches.length) {
      const titleMatches = matches.filter((pattern) => titleText.includes(pattern));
      macroSignals.push({
        type: rule.type,
        strength: clamp(35 + matches.length * 10 + titleMatches.length * 8, 0, 100),
        patterns: matches,
      });
    }
  }

  return macroSignals;
}

/* =========================================================
SECTOR IMPACT MODEL
========================================================= */

function estimateSectorImpact(macroSignals = []) {
  const sectorImpact = {};

  for (const signal of macroSignals) {
    if (signal.type === "oil") {
      sectorImpact.energy = 80;
      sectorImpact.airlines = -40;
      sectorImpact.transportation = -25;
    }

    if (signal.type === "interest_rates") {
      sectorImpact.banks = 60;
      sectorImpact.technology = -35;
      sectorImpact.real_estate = -45;
    }

    if (signal.type === "ai") {
      sectorImpact.semiconductors = 70;
      sectorImpact.software = 60;
      sectorImpact.cloud = 55;
    }

    if (signal.type === "semiconductors") {
      sectorImpact.semiconductors = 85;
      sectorImpact.hardware = 60;
    }

    if (signal.type === "banking") {
      sectorImpact.banks = 75;
      sectorImpact.financials = 55;
    }

    if (signal.type === "inflation") {
      sectorImpact.consumer = -25;
      sectorImpact.bonds = -35;
      sectorImpact.energy = 20;
    }
  }

  return sectorImpact;
}

/* =========================================================
THEME EXPANSION
========================================================= */

function expandThemes(themes = [], macroSignals = []) {
  const expanded = [...themes];

  for (const signal of macroSignals) {
    if (signal.type === "ai") expanded.push("artificial intelligence");
    if (signal.type === "oil") expanded.push("energy");
    if (signal.type === "interest_rates") expanded.push("monetary policy");
    if (signal.type === "inflation") expanded.push("macro inflation");
    if (signal.type === "semiconductors") expanded.push("chips");
    if (signal.type === "banking") expanded.push("financial stability");
  }

  return uniqueStrings(expanded, 50);
}

/* =========================================================
MARKET IMPACT SCORE
========================================================= */

function computeMarketImpactScore({
  relevanceScore = 0,
  eventStrength = 0,
  macroSignals = [],
  sectorImpact = {},
}) {
  let score = relevanceScore * 0.6 + eventStrength * 0.4;

  if (macroSignals.length) score += 15;
  if (Object.keys(sectorImpact).length) score += 10;

  return clamp(Math.round(score), 0, 100);
}

function buildRelevanceScore({
  topMatchScore = 0,
  matchCount = 0,
  eventStrength = 0,
  sourceQuality = 50,
  freshnessScore = 40,
  sentimentStrength = 50,
  macroSignals = [],
}) {
  const score =
    topMatchScore * 0.38 +
    eventStrength * 0.24 +
    sourceQuality * 0.14 +
    freshnessScore * 0.12 +
    Math.max(0, sentimentStrength - 50) * 0.08 +
    clamp(matchCount * 3, 0, 8) +
    clamp(macroSignals.length * 2, 0, 6);

  return clamp(Math.round(score), 0, 100);
}

function buildConfidence({
  matchCount = 0,
  topMatchScore = 0,
  matchedPatterns = [],
  sourceQuality = 50,
  freshnessScore = 40,
  macroSignals = [],
}) {
  let confidence = 18;

  confidence += clamp(topMatchScore * 0.38, 0, 38);
  confidence += clamp(matchCount * 6, 0, 18);
  confidence += clamp(matchedPatterns.length * 5, 0, 15);
  confidence += clamp((sourceQuality - 50) * 0.3, 0, 12);
  confidence += clamp((freshnessScore - 40) * 0.2, 0, 12);
  confidence += clamp(macroSignals.length * 3, 0, 9);

  if (!matchCount && !matchedPatterns.length) {
    confidence -= 10;
  }

  return clamp(Math.round(confidence), 0, 100);
}

function analyzeNewsArticle(article = {}, entityMapBySymbol = {}) {
  const matchedEntities = collectEntityMatches(article, entityMapBySymbol);
  const filteredMatches = matchedEntities.filter((item) => item.matchScore >= 12);

  const eventInfo = classifyEvent(article, filteredMatches);
  const sentimentInfo = detectSentiment(article);
  const freshnessScore = computeFreshnessScore(article);
  const sourceQuality = computeSourceQualityScore(article);
  const macroSignals = detectMacroSignals(article);
  const sectorImpact = estimateSectorImpact(macroSignals);
  const marketSentiment = buildEmbeddedMarketSentiment({
    article,
    sentimentInfo,
    freshnessScore,
    sourceQuality,
    matchCount: filteredMatches.length,
  });

  const topMatchScore = filteredMatches.length ? filteredMatches[0].matchScore : 0;

  const relevanceScore = buildRelevanceScore({
    topMatchScore,
    matchCount: filteredMatches.length,
    eventStrength: eventInfo.eventStrength,
    sourceQuality,
    freshnessScore,
    sentimentStrength: sentimentInfo.sentimentStrength,
    macroSignals,
  });

  const confidence = buildConfidence({
    matchCount: filteredMatches.length,
    topMatchScore,
    matchedPatterns: eventInfo.matchedPatterns,
    sourceQuality,
    freshnessScore,
    macroSignals,
  });

  const direction =
    sentimentInfo.direction !== "neutral"
      ? sentimentInfo.direction
      : eventInfo.direction;

  const sectors = aggregateSectors(filteredMatches);
  const industries = aggregateIndustries(filteredMatches);

  const baseThemes = aggregateThemes(filteredMatches);
  const themes = expandThemes(baseThemes, macroSignals);

  const reasons = uniqueStrings(
    [
      filteredMatches[0]
        ? `Top-Symbol ${filteredMatches[0].symbol} mit MatchScore ${filteredMatches[0].matchScore}`
        : null,
      ...filteredMatches.flatMap((item) => item.matchReasons || []),
      `Event klassifiziert als ${eventInfo.eventType} (Stärke ${eventInfo.eventStrength})`,
      ...eventInfo.matchedPatterns.map((pattern) => `Event-Muster: ${pattern}`),
      sentimentInfo.direction !== "neutral"
        ? `Sentiment ${sentimentInfo.direction} (Stärke ${sentimentInfo.sentimentStrength})`
        : "Sentiment neutral",
      ...macroSignals.map(
        (signal) => `Makro-Signal ${signal.type} mit Stärke ${signal.strength}`
      ),
      ...macroSignals.flatMap((signal) =>
        (signal.patterns || []).map((pattern) => `Makro-Signal ${signal.type}: ${pattern}`)
      ),
      `FreshnessScore ${freshnessScore}`,
      `SourceQuality ${sourceQuality}`,
    ],
    30
  );

  return {
    title: article?.title || null,
    url: article?.url || null,
    source: article?.source || null,
    publishedAt: article?.publishedAt || null,

    symbols: filteredMatches.map((item) => item.symbol),
    sectors,
    industries,
    themes,

    eventType: eventInfo.eventType,
    direction,
    horizon: eventInfo.horizon,

    relevanceScore,
    confidence,
    eventStrength: eventInfo.eventStrength,
    freshnessScore,
    sourceQuality,
    sentimentStrength: sentimentInfo.sentimentStrength,
    marketSentiment,

    macroSignals,
    sectorImpact,
    marketImpactScore: computeMarketImpactScore({
      relevanceScore,
      eventStrength: eventInfo.eventStrength,
      macroSignals,
      sectorImpact,
    }),

    entityMatches: filteredMatches.map((item) => ({
      symbol: item.symbol,
      companyName: item.companyName,
      sector: item.sector,
      industry: item.industry,
      matchScore: item.matchScore,
      matchReasons: item.matchReasons,
    })),

    reasons,
  };
}

module.exports = {
  analyzeNewsArticle,
  buildNewsLifecycle,
};
