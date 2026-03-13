"use strict";

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
        "revenue",
        "eps",
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
    const matchedPatterns = rule.patterns.filter((pattern) =>
      text.includes(pattern.toLowerCase())
    );

    if (!matchedPatterns.length) continue;

    const score = rule.weight + matchedPatterns.length * 3;
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

  return {
    eventType: best.eventType,
    direction: normalizeDirection(best.direction),
    horizon: best.horizon,
    eventStrength: clamp(best.score, 0, 100),
    matchedPatterns: uniqueStrings(best.matchedPatterns, 10),
  };
}

function detectSentiment(article = {}) {
  const text = buildNewsTextBlob(article).toLowerCase();

  const bullishPatterns = [
    "beats expectations",
    "beat expectations",
    "raises guidance",
    "strong demand",
    "record revenue",
    "surge",
    "jump",
    "growth",
    "profit rises",
    "upgrade",
    "buyback",
  ];

  const bearishPatterns = [
    "misses expectations",
    "missed expectations",
    "cuts guidance",
    "weak demand",
    "decline",
    "drop",
    "fall",
    "warning",
    "downgrade",
    "lawsuit",
    "probe",
    "investigation",
  ];

  const bullish = bullishPatterns.filter((pattern) => text.includes(pattern)).length;
  const bearish = bearishPatterns.filter((pattern) => text.includes(pattern)).length;

  if (bullish > bearish) {
    return {
      direction: "bullish",
      sentimentStrength: clamp(50 + bullish * 10 - bearish * 4, 0, 100),
    };
  }

  if (bearish > bullish) {
    return {
      direction: "bearish",
      sentimentStrength: clamp(50 + bearish * 10 - bullish * 4, 0, 100),
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

  const macroSignals = [];

  const rules = [
    {
      type: "interest_rates",
      patterns: ["fed", "interest rate", "rate hike", "rate cut", "central bank"],
    },
    {
      type: "inflation",
      patterns: ["inflation", "cpi", "ppi", "consumer price"],
    },
    {
      type: "oil",
      patterns: ["oil", "crude", "opec", "brent"],
    },
    {
      type: "ai",
      patterns: ["artificial intelligence", "ai chips", "ai boom"],
    },
    {
      type: "semiconductors",
      patterns: ["semiconductor", "chips", "tsmc", "nvidia"],
    },
    {
      type: "banking",
      patterns: ["banking crisis", "bank collapse", "liquidity"],
    },
  ];

  for (const rule of rules) {
    const matches = rule.patterns.filter((pattern) => text.includes(pattern));
    if (matches.length) {
      macroSignals.push({
        type: rule.type,
        strength: clamp(matches.length * 10 + 40, 0, 100),
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
  eventStrength = 0,
  sourceQuality = 50,
  freshnessScore = 40,
  sentimentStrength = 50,
}) {
  const score =
    topMatchScore * 0.35 +
    eventStrength * 0.25 +
    sourceQuality * 0.15 +
    freshnessScore * 0.15 +
    sentimentStrength * 0.10;

  return clamp(Math.round(score), 0, 100);
}

function buildConfidence({
  matchCount = 0,
  topMatchScore = 0,
  matchedPatterns = [],
  sourceQuality = 50,
  macroSignals = [],
}) {
  let confidence = 30;

  confidence += clamp(topMatchScore * 0.4, 0, 40);
  confidence += clamp(matchCount * 5, 0, 15);
  confidence += clamp(matchedPatterns.length * 4, 0, 12);
  confidence += clamp((sourceQuality - 50) * 0.25, 0, 15);
  confidence += clamp(macroSignals.length * 4, 0, 12);

  return clamp(Math.round(confidence), 0, 100);
}

function analyzeNewsArticle(article = {}, entityMapBySymbol = {}) {
  const matchedEntities = collectEntityMatches(article, entityMapBySymbol);
  const filteredMatches = matchedEntities.filter((item) => item.matchScore >= 12);

  const eventInfo = classifyEvent(article, filteredMatches);
  const sentimentInfo = detectSentiment(article);
  const freshnessScore = computeFreshnessScore(article);
  const sourceQuality = computeSourceQualityScore(article);

  const topMatchScore = filteredMatches.length ? filteredMatches[0].matchScore : 0;

  const relevanceScore = buildRelevanceScore({
    topMatchScore,
    eventStrength: eventInfo.eventStrength,
    sourceQuality,
    freshnessScore,
    sentimentStrength: sentimentInfo.sentimentStrength,
  });

  const macroSignals = detectMacroSignals(article);
  const sectorImpact = estimateSectorImpact(macroSignals);

  const confidence = buildConfidence({
    matchCount: filteredMatches.length,
    topMatchScore,
    matchedPatterns: eventInfo.matchedPatterns,
    sourceQuality,
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
      ...filteredMatches.flatMap((item) => item.matchReasons || []),
      ...eventInfo.matchedPatterns.map((pattern) => `Event-Muster: ${pattern}`),
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
};
