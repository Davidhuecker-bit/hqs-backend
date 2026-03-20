const DEFAULT_FRONTEND_SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMD"];

// ── Canonical field contract ─────────────────────────────────────────────────
// These are the integrationEngine output fields that the frontend depends on.
// hasCanonicalFields() lets normalizeStockForFrontend mark stocks that arrived
// without a full pipeline run so consumers know to interpret them as degraded.
const CANONICAL_FIELDS = [
  "finalConviction",
  "finalConfidence",
  "finalRating",
  "finalDecision",
  "whyInteresting",
  "components",
];

/**
 * Returns true when a raw stock object carries all canonical integrationEngine
 * output fields.  False means the stock bypassed the full pipeline; inferred
 * scores (hqsScore-based) are used instead and `_degraded` is set on output.
 *
 * @param {object|null} stock
 * @returns {boolean}
 */
function hasCanonicalFields(stock) {
  // finalConviction and finalRating are the primary integrationEngine signals.
  // Their presence indicates the stock completed the full conviction pipeline.
  return stock?.finalConviction != null && stock?.finalRating != null;
}

const SYMBOL_META = {
  AAPL: { name: "Apple", category: "Consumer Tech", marketCap: "Large Cap", type: "Aktie" },
  MSFT: { name: "Microsoft", category: "Cloud AI", marketCap: "Large Cap", type: "Aktie" },
  NVDA: { name: "NVIDIA", category: "AI Semiconductors", marketCap: "Large Cap", type: "Aktie" },
  AMD: { name: "AMD", category: "Semiconductors", marketCap: "Large Cap", type: "Aktie" },
  GOOGL: { name: "Alphabet", category: "Cloud AI", marketCap: "Large Cap", type: "Aktie" },
  AMZN: { name: "Amazon", category: "Cloud Commerce", marketCap: "Large Cap", type: "Aktie" },
  META: { name: "Meta", category: "AI Platforms", marketCap: "Large Cap", type: "Aktie" },
  TSLA: { name: "Tesla", category: "EV Mobility", marketCap: "Large Cap", type: "Aktie" },
  IONQ: { name: "IONQ", category: "Quantum", marketCap: "Mid Cap", type: "Aktie" },
  SOUN: { name: "SoundHound", category: "Voice AI", marketCap: "Small Cap", type: "Aktie" },
};

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeSymbol(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(normalized)) return "";
  return normalized;
}

function parseSymbolsQuery(rawValue, fallback = DEFAULT_FRONTEND_SYMBOLS) {
  const source = Array.isArray(rawValue) ? rawValue.join(",") : rawValue;
  const requested = String(source || "")
    .split(",")
    .map((symbol) => sanitizeSymbol(symbol))
    .filter(Boolean);

  if (requested.length === 0) return fallback.slice(0, 4);
  return [...new Set(requested)].slice(0, 8);
}

function classifyMarketCap(rawMarketCap, symbol) {
  if (typeof rawMarketCap === "string") {
    if (rawMarketCap === "Large Cap" || rawMarketCap === "Mid Cap" || rawMarketCap === "Small Cap") {
      return rawMarketCap;
    }
  }

  const numeric = toFiniteNumber(rawMarketCap, Number.NaN);
  if (Number.isFinite(numeric)) {
    if (numeric >= 2e11) return "Large Cap";
    if (numeric >= 1e10) return "Mid Cap";
    return "Small Cap";
  }

  return SYMBOL_META[symbol]?.marketCap || "Mid Cap";
}

function inferTrend(changePercent) {
  if (changePercent >= 6) return "Starker Aufw\u00e4rtstrend";
  if (changePercent >= 3) return "Breakout";
  if (changePercent >= 0.5) return "Aufw\u00e4rtstrend";
  if (changePercent >= -1.5) return "Seitw\u00e4rts";
  return "Konsolidierung";
}

function inferAllocation(score) {
  if (score >= 78) return "Kernposition";
  if (score >= 68) return "Tech \u00dcberzeugung";
  if (score >= 58) return "Wachstum";
  if (score >= 48) return "Rotation";
  return "Fr\u00fcherkennung";
}

function inferRecommendation(score) {
  if (score >= 75) return "Starke Technische Übereinstimmung";
  if (score >= 62) return "Technische Übereinstimmung";
  if (score >= 50) return "Analytisches Signal – beobachten";
  return "Kein klares Analytisches Signal";
}

function inferVolatility(changePercent) {
  const scaled = 0.012 + Math.abs(changePercent) * 0.003;
  return Number(clamp(scaled, 0.008, 0.08).toFixed(4));
}

function buildSyntheticNewsItems(stock, generatedAt, maxItems = 3) {
  const symbol = sanitizeSymbol(stock?.symbol);
  if (!symbol) return [];

  const changePercent = toFiniteNumber(stock?.changePercent, 0);
  const hqsScore = toFiniteNumber(stock?.hqsScore, 50);

  const sentimentTitle =
    changePercent >= 0
      ? `${symbol}: Momentum bleibt bei +${changePercent.toFixed(2)}%`
      : `${symbol}: Korrekturphase bei ${changePercent.toFixed(2)}%`;
  const scoreTitle =
    hqsScore >= 70
      ? `${symbol}: Analytisches Signal auf hohem Niveau`
      : `${symbol}: Quant-Signal im neutralen Bereich`;
  const riskTitle =
    hqsScore < 50
      ? `${symbol}: Risikoindikatoren bleiben erhoht`
      : `${symbol}: Stabilitatsindikatoren ohne Warnsignal`;

  const titles = [sentimentTitle, scoreTitle, riskTitle].slice(0, maxItems);
  const baseDate = new Date(generatedAt || Date.now()).getTime();

  return titles.map((title, index) => ({
    title,
    link: `https://finance.yahoo.com/quote/${symbol}`,
    source: index === 0 ? "HQS Wire" : "Market Pulse",
    publishedAt: new Date(baseDate - index * 45 * 60 * 1000).toISOString(),
  }));
}

function normalizeStockForFrontend(stock, index = 0, generatedAt = new Date().toISOString()) {
  const symbol = sanitizeSymbol(stock?.symbol);
  if (!symbol) return null;

  const meta = SYMBOL_META[symbol] || {};
  const hqsScore = clamp(Math.round(toFiniteNumber(stock?.hqsScore, 50)), 0, 100);
  const stabilityScore = clamp(Math.round(toFiniteNumber(stock?.stabilityScore, 55)), 0, 100);
  const changePercent = Number(
    toFiniteNumber(stock?.changePercent ?? stock?.changesPercentage, 0).toFixed(2),
  );
  const volatility = clamp(toFiniteNumber(stock?.volatility, inferVolatility(changePercent)), 0.005, 0.08);
  const marketCap = classifyMarketCap(stock?.marketCap, symbol);

  // Prefer finalConviction (integrationEngine output) as effective score for
  // allocation/recommendation inferences when available; fall back to hqsScore.
  const effectiveScore = toFiniteNumber(stock?.finalConviction, null) ?? hqsScore;

  const volatilityScore = clamp(Math.round(volatility * 1400), 0, 100);
  const correlationScore = clamp(Math.round(35 + (symbol.charCodeAt(0) % 30) + index * 4), 0, 100);
  const sentimentScore = clamp(Math.round(55 - changePercent * 4), 0, 100);
  // Prefer finalConfidence (integrationEngine output) when available; fall back to computed.
  const computedConfidence = clamp(
    Math.round(hqsScore * 0.6 + stabilityScore * 0.25 + (100 - volatilityScore) * 0.15),
    35,
    95,
  );
  const confidence = toFiniteNumber(stock?.finalConfidence, null) !== null
    ? clamp(toFiniteNumber(stock.finalConfidence), 35, 95)
    : computedConfidence;

  const fallbackNews = buildSyntheticNewsItems(
    { symbol, changePercent, hqsScore },
    generatedAt,
    2,
  );
  const normalizedNews = Array.isArray(stock?.news)
    ? stock.news
        .filter((entry) => entry && String(entry.title || "").trim())
        .map((entry) => ({
          title: String(entry.title || "").trim(),
          link: String(entry.link || `https://finance.yahoo.com/quote/${symbol}`),
          source: String(entry.source || "News"),
          publishedAt: String(entry.publishedAt || generatedAt),
        }))
    : fallbackNews;

  return {
    ...stock,
    symbol,
    name: String(stock?.name || meta.name || symbol),
    type: String(stock?.type || meta.type || "Aktie"),
    category: String(stock?.category || meta.category || "Unkategorisiert"),
    marketCap,
    allocation: String(stock?.allocation || inferAllocation(effectiveScore)),
    trend: String(stock?.trend || inferTrend(changePercent)),
    // Prefer stored recommendation → integrationEngine finalRating → inferred from effectiveScore.
    recommendation: String(stock?.recommendation || stock?.finalRating || inferRecommendation(effectiveScore)),
    price: toFiniteNumber(stock?.price, 0),
    changePercent,
    hqsScore,
    stabilityScore,
    volatility: Number(volatility.toFixed(4)),
    volatilityScore,
    correlationScore,
    sentimentScore,
    confidence,
    // Canonical integrationEngine output fields (explicit passthrough, null when not present).
    finalConviction: stock?.finalConviction ?? null,
    finalConfidence: stock?.finalConfidence ?? null,
    finalRating: stock?.finalRating ?? null,
    finalDecision: stock?.finalDecision ?? null,
    whyInteresting: Array.isArray(stock?.whyInteresting) ? stock.whyInteresting : [],
    components: stock?.components ?? null,
    // _degraded: true signals that integrationEngine canonical fields are absent;
    // inferred hqsScore-based values are used instead of finalConviction pipeline output.
    _degraded: !hasCanonicalFields(stock),
    // Step 4: Personalized portfolio/watchlist context (pass-through from opportunityScanner).
    portfolioContext: stock?.portfolioContext ?? null,
    // Step 4b: Delta/change context (pass-through from opportunityScanner).
    deltaContext: stock?.deltaContext ?? null,
    // Step 4c: Next action hint (computed by opportunityScanner from delta + portfolio signals).
    nextAction: stock?.nextAction ?? null,
    // Step 5: User attention level and reason (derived from portfolio/delta/action signals).
    userAttentionLevel: stock?.userAttentionLevel ?? null,
    attentionReason: stock?.attentionReason ?? null,
    // Step 5b: Action-Orchestration – HOW the system treats this signal (deliveryMode, escalationLevel, etc.)
    actionOrchestration: stock?.actionOrchestration ?? null,
    // Step 5: Feedback/Reaction context – if the stock was part of a notification, surface its reaction signals.
    feedbackContext: stock?.feedbackContext ?? null,
    // Step 5 Follow-up/Reminder: follow-up/reminder status derived from notification reaction data.
    // followUpContext is passed through from the opportunityScanner/route handler if available.
    followUpContext: stock?.followUpContext ?? null,
    news: normalizedNews.slice(0, 3),
  };
}

function average(values, fallback = 0) {
  if (!Array.isArray(values) || values.length === 0) return fallback;
  const numeric = values.map((value) => toFiniteNumber(value, Number.NaN)).filter(Number.isFinite);
  if (numeric.length === 0) return fallback;
  return numeric.reduce((acc, value) => acc + value, 0) / numeric.length;
}

function buildTopSignals(stocks) {
  const DELTA_CHANGE_BADGES = {
    new_signal:               "Neu",
    gaining_relevance:        "↑ Relevanz",
    risk_increased:           "⚠ Risiko",
    losing_conviction:        "↓ Conviction",
    portfolio_impact_changed: "Portfolio-Impact",
  };

  // Step 5: attention-level sort boost – keeps conviction dominant (100-pt scale)
  // while surfacing critical/high-attention signals to the top of the list.
  const ATTENTION_SORT_BOOST = { critical: 20, high: 10, medium: 3, low: 0 };

  // Step 5b: delivery-mode badge – surfaces action-orchestration in top signal summaries.
  const DELIVERY_MODE_BADGES = {
    briefing_and_notification: "🔔 Jetzt",
    notification:  "🔔",
    briefing:      "📋",
    passive_briefing: null,
    none: null,
  };

  // Step 5 Follow-up/Reminder: follow-up status badge
  const FOLLOW_UP_STATUS_BADGES = {
    overdue:  "⏰ Überfällig",
    pending:  "🔁 Wiedervorlage",
    closed:   null,
    none:     null,
  };

  return stocks
    .slice()
    .sort((left, right) => {
      // Prefer finalConviction (integrationEngine) over raw hqsScore for ranking.
      const leftScore = toFiniteNumber(left.finalConviction ?? left.hqsScore, 0) + toFiniteNumber(left.changePercent, 0) * 2;
      const rightScore = toFiniteNumber(right.finalConviction ?? right.hqsScore, 0) + toFiniteNumber(right.changePercent, 0) * 2;
      // Step 5: boost critical/high attention signals to the top
      const leftBoost  = ATTENTION_SORT_BOOST[left.userAttentionLevel  || "low"] || 0;
      const rightBoost = ATTENTION_SORT_BOOST[right.userAttentionLevel || "low"] || 0;
      return (rightScore + rightBoost) - (leftScore + leftBoost);
    })
    .slice(0, 3)
    .map((stock) => {
      const ctx        = stock.portfolioContext ?? null;
      const delta      = stock.deltaContext     ?? null;
      const action     = stock.nextAction       ?? null;
      const orch       = stock.actionOrchestration ?? null;
      const followUp   = stock.followUpContext  ?? null;
      const attention  = stock.userAttentionLevel ? ` [Achtung: ${stock.userAttentionLevel}]` : "";
      // Append portfolio-context badge, intelligence label, delta badge, next-action badge, delivery-mode badge, and follow-up badge.
      const ctxBadge          = ctx?.portfolioContextLabel       ? ` · ${ctx.portfolioContextLabel}`       : "";
      const intelligenceBadge = ctx?.portfolioIntelligenceLabel  ? ` [${ctx.portfolioIntelligenceLabel}]` : "";
      const deltaBadge        = delta?.changeType && delta.changeType !== "stable"
        ? ` · ${DELTA_CHANGE_BADGES[delta.changeType] || "Änderung"}`
        : "";
      const actionBadge       = action?.nextActionLabel ? ` → ${action.nextActionLabel}` : "";
      const deliveryBadge     = orch?.deliveryMode && DELIVERY_MODE_BADGES[orch.deliveryMode]
        ? ` ${DELIVERY_MODE_BADGES[orch.deliveryMode]}`
        : "";
      const followUpBadge     = followUp?.followUpStatus && FOLLOW_UP_STATUS_BADGES[followUp.followUpStatus]
        ? ` ${FOLLOW_UP_STATUS_BADGES[followUp.followUpStatus]}`
        : "";
      return {
        symbol: stock.symbol,
        type: toFiniteNumber(stock.finalConviction ?? stock.hqsScore, 0) >= 70 ? "momentum" : "watch",
        score: clamp(Math.round(toFiniteNumber(stock.finalConviction ?? stock.hqsScore, 0)), 0, 100),
        summary: `${stock.symbol}: HQS ${stock.hqsScore}, Bewegung ${stock.changePercent >= 0 ? "+" : ""}${stock.changePercent.toFixed(2)}%${ctxBadge}${intelligenceBadge}${deltaBadge}${actionBadge}${attention}${deliveryBadge}${followUpBadge}`,
        portfolioContext: ctx,
        deltaContext: delta,
        nextAction: action,
        actionOrchestration: orch,
        userAttentionLevel: stock.userAttentionLevel ?? null,
        attentionReason: stock.attentionReason ?? null,
        feedbackContext: stock.feedbackContext ?? null,
        followUpContext: followUp,
      };
    });
}

function buildRiskFlags(stocks) {
  const flags = stocks
    // Prefer finalConviction (integrationEngine) over raw hqsScore for risk assessment.
    .filter((stock) => toFiniteNumber(stock.finalConviction ?? stock.hqsScore, 50) < 50 || toFiniteNumber(stock.changePercent, 0) <= -2)
    .slice(0, 4)
    .map((stock) => ({
      symbol: stock.symbol,
      level: toFiniteNumber(stock.finalConviction ?? stock.hqsScore, 50) < 40 ? "high" : "medium",
      message: `${stock.symbol}: defensives Monitoring empfohlen.`,
    }));

  if (flags.length > 0) return flags;
  return [{ level: "low", message: "Keine kritischen Risiko-Flags im aktuellen Snapshot." }];
}

function buildAlerts(stocks) {
  const alerts = [];
  stocks.forEach((stock) => {
    const changePercent = toFiniteNumber(stock.changePercent, 0);
    if (changePercent >= 6) {
      alerts.push({
        id: `alert-${stock.symbol}-momentum`,
        symbol: stock.symbol,
        level: "info",
        message: `${stock.symbol} zeigt starkes Tagesmomentum (+${changePercent.toFixed(2)}%).`,
      });
    } else if (changePercent <= -4) {
      alerts.push({
        id: `alert-${stock.symbol}-risk`,
        symbol: stock.symbol,
        level: "warning",
        message: `${stock.symbol} zeigt einen deutlichen Rucksetzer (${changePercent.toFixed(2)}%).`,
      });
    }
  });

  return alerts.slice(0, 5);
}

function buildCorrelationSeries(stocks, generatedAt) {
  return {
    generatedAt,
    points: stocks.map((stock) => ({
      symbol: stock.symbol,
      value: toFiniteNumber(stock.correlationScore, 0),
    })),
  };
}

function buildNextActionSummary(stocks) {
  const counts = {};
  stocks.forEach((s) => {
    const t = s.nextAction?.actionType;
    if (t) counts[t] = (counts[t] || 0) + 1;
  });
  return counts;
}

function buildPortfolioIntelligenceSummary(stocks) {
  const withCtx = stocks.filter((s) => s.portfolioContext?.portfolioRole
    && s.portfolioContext.portfolioRole !== "unknown");
  if (withCtx.length === 0) return null;

  // Delta counts: how many signals changed state since last engine run.
  const deltaElevated = stocks.filter((s) => s.deltaContext?.deltaPriority === "elevated").length;
  const deltaCaution  = stocks.filter((s) => s.deltaContext?.deltaPriority === "caution").length;
  const deltaDegraded = stocks.filter((s) => s.deltaContext?.deltaPriority === "degraded").length;

  return {
    diversifiers:          withCtx.filter((s) => s.portfolioContext.portfolioRole === "diversifier").length,
    redundant:             withCtx.filter((s) => s.portfolioContext.portfolioRole === "redundant").length,
    additive:              withCtx.filter((s) => s.portfolioContext.portfolioRole === "additive").length,
    complement:            withCtx.filter((s) => s.portfolioContext.portfolioRole === "complement").length,
    highConcentrationRisk: withCtx.filter((s) => s.portfolioContext.concentrationRisk === "high").length,
    total:                 withCtx.length,
    // Delta summary: count of signals that changed relevance/risk since last run.
    delta: {
      elevated: deltaElevated,
      caution:  deltaCaution,
      degraded: deltaDegraded,
    },
    // Next-action summary: count by actionType across all stocks with a computed action.
    nextActionSummary: buildNextActionSummary(stocks),
    // Step 5: attention distribution – how many signals require user attention at each level.
    attention: {
      critical: stocks.filter((s) => s.userAttentionLevel === "critical").length,
      high:     stocks.filter((s) => s.userAttentionLevel === "high").length,
      medium:   stocks.filter((s) => s.userAttentionLevel === "medium").length,
    },
    // Step 5b: action-orchestration summary – escalation and follow-up counts across all stocks.
    orchestration: {
      escalateHigh:   stocks.filter((s) => s.actionOrchestration?.escalationLevel === "high").length,
      escalateMedium: stocks.filter((s) => s.actionOrchestration?.escalationLevel === "medium").length,
      followUpNeeded: stocks.filter((s) => s.actionOrchestration?.followUpNeeded === true).length,
      deliveryModes: {
        briefingAndNotification: stocks.filter((s) => s.actionOrchestration?.deliveryMode === "briefing_and_notification").length,
        notification:  stocks.filter((s) => s.actionOrchestration?.deliveryMode === "notification").length,
        briefing:      stocks.filter((s) => s.actionOrchestration?.deliveryMode === "briefing").length,
      },
    },
    // Step 5: feedback/reaction summary – how users responded to signals for these stocks.
    feedback: {
      positive: stocks.filter((s) => s.feedbackContext?.feedbackSignal === "positive").length,
      negative: stocks.filter((s) => s.feedbackContext?.feedbackSignal === "negative").length,
      acted:    stocks.filter((s) => s.feedbackContext?.responseType === "acted" || s.feedbackContext?.actedAt != null).length,
      dismissed: stocks.filter((s) => s.feedbackContext?.dismissedAt != null).length,
    },
    // Step 5 Follow-up/Reminder: summary of follow-up/reminder states across all stocks.
    followUp: {
      overdue:          stocks.filter((s) => s.followUpContext?.followUpStatus === "overdue").length,
      pending:          stocks.filter((s) => s.followUpContext?.followUpStatus === "pending").length,
      reminderEligible: stocks.filter((s) => s.followUpContext?.reminderEligible === true).length,
      reviewDue:        stocks.filter((s) => s.followUpContext?.reviewDue === true).length,
      needsClosure:     stocks.filter((s) => s.followUpContext?.needsClosure === true).length,
    },
  };
}

function buildPortfolioHealth(stocks, stabilityScore) {
  const avgHqs = average(stocks.map((stock) => stock.hqsScore), 50);
  const avgRisk = average(stocks.map((stock) => stock.volatilityScore), 50);
  const score = clamp(Math.round(avgHqs * 0.62 + stabilityScore * 0.3 - (avgRisk - 50) * 0.18), 0, 100);
  const status = score >= 70 ? "robust" : score >= 55 ? "balanced" : "defensive";
  return {
    score,
    status,
    avgHqs: Number(avgHqs.toFixed(1)),
    avgRisk: Number(avgRisk.toFixed(1)),
  };
}

function createFallbackStocks(symbols, generatedAt) {
  return symbols
    .map((symbol, index) =>
      normalizeStockForFrontend(
        {
          symbol,
          price: 100 + index * 25,
          changePercent: index % 2 === 0 ? 1.2 + index : -0.8 - index * 0.2,
          hqsScore: 58 + index * 6,
          stabilityScore: 55 + index * 4,
          // _isSyntheticFallback marks stocks created as placeholders when no
          // real pipeline data is available; always _degraded by definition.
          _isSyntheticFallback: true,
        },
        index,
        generatedAt,
      ),
    )
    .filter(Boolean);
}

function buildGuardianPayload(rawStocks, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const incomingStocks = Array.isArray(rawStocks) ? rawStocks : [];
  let stocks = incomingStocks
    .map((stock, index) => normalizeStockForFrontend(stock, index, generatedAt))
    .filter(Boolean);

  if (stocks.length === 0) {
    stocks = createFallbackStocks(DEFAULT_FRONTEND_SYMBOLS.slice(0, 3), generatedAt);
  }

  const stabilityScore = clamp(Math.round(average(stocks.map((stock) => stock.stabilityScore), 55)), 0, 100);
  const topSignals = buildTopSignals(stocks);
  const riskFlags = buildRiskFlags(stocks);
  const alerts = buildAlerts(stocks);
  const portfolioIntelligence = buildPortfolioIntelligenceSummary(stocks);

  // Step 5 User-State: include consolidated user-state if provided by caller (e.g. from route handler).
  // The route handler can preload computeUserState(userId) and pass it here via options.userState.
  const userState = options.userState ?? null;

  return {
    success: true,
    stabilityScore,
    engineStatus: {
      mode: "HQS Guardian Hybrid",
      source: "Finnhub + HQS Engine",
      generatedAt,
      symbolCount: stocks.length,
      // canonicalCount: stocks with full integrationEngine output (finalConviction present).
      // Remaining stocks use hqsScore-based inferred values (_degraded: true).
      canonicalCount: stocks.filter((s) => !s._degraded).length,
    },
    portfolioHealth: buildPortfolioHealth(stocks, stabilityScore),
    portfolioIntelligence,
    // Step 5 User-State: consolidated user state summary (null when not supplied).
    userState,
    topSignals,
    riskFlags,
    correlationSeries: buildCorrelationSeries(stocks, generatedAt),
    alerts,
    marketSnapshot: {
      updatedAt: generatedAt,
      stocks,
    },
  };
}

module.exports = {
  DEFAULT_FRONTEND_SYMBOLS,
  parseSymbolsQuery,
  normalizeStockForFrontend,
  buildGuardianPayload,
  hasCanonicalFields,
  CANONICAL_FIELDS,
};
