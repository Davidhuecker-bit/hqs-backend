"use strict";

/*
  Synthetic Stress-Test  –  Recursive Meta-Learning / Black Swan Engine
  -----------------------------------------------------------------------
  Extends the existing market-stress simulation with extreme "phantom"
  scenarios that represent tail-risk events:

    FLASH_CRASH       – sudden -20 % price dislocation within one session
    SECTOR_CONTAGION  – sector-wide -25 % sell-off triggered by a leader
    LIQUIDITY_CRISIS  – volume collapses by 70 %, spreads widen
    RATE_SHOCK        – central-bank shock (+300 bps), quality / stability hit
    BLACK_SWAN        – combined worst-case: -40 % price, -60 % volume,
                        -50 % momentum, elevated volatility

  For each scenario the engine evaluates whether a snapshot retains a viable
  signal (using the same `meetsMinimumSignalCriteria` logic as the existing
  stress engine) and assigns an "antifragility score" that quantifies how many
  extreme scenarios a stock survives.

  runBlackSwanTest(snapshot)
    → { antifragilityScore, scenarioResults, antifragile }

  rankPortfolioAntifragility(portfolioRows)
    → Array sorted by antifragilityScore desc

  Both functions are pure (no DB / network calls) to keep them fast.
*/

const logger = require("../utils/logger");

/* =========================================================
   HELPERS (duplicated from opportunityScanner to keep this
   module self-contained with zero circular deps)
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  const x = safeNum(n, min);
  return Math.max(min, Math.min(max, x));
}

/* =========================================================
   MINIMUM SIGNAL CRITERIA  (mirrors opportunityScanner thresholds)
========================================================= */

const MIN_HQS_SCORE           = 35;
const MIN_OPPORTUNITY_SCORE   = 30;
const MIN_OPPORTUNITY_STRENGTH = 20;

// Opportunity score weighting coefficients (mirror opportunityScanner.service.js)
const OPP_SCORE_W_HQS       = 0.55;
const OPP_SCORE_W_MOMENTUM  = 10;
const OPP_SCORE_W_QUALITY   = 18;
const OPP_SCORE_W_STABILITY = 18;
const OPP_SCORE_W_RELATIVE  = 10;
const OPP_SCORE_W_VOLATILITY = 12; // negative contribution

function calculateOpportunityScore(features) {
  const hqs       = safeNum(features.hqsScore, 0);
  const momentum  = safeNum(features.momentum, 0);
  const quality   = safeNum(features.quality, 0);
  const stability = safeNum(features.stability, 0);
  const relative  = safeNum(features.relative, 0);
  const vol       = safeNum(features.volatility, 0);

  const score = hqs      * OPP_SCORE_W_HQS
    + momentum            * OPP_SCORE_W_MOMENTUM
    + quality             * OPP_SCORE_W_QUALITY
    + stability           * OPP_SCORE_W_STABILITY
    + relative            * OPP_SCORE_W_RELATIVE
    - vol                 * OPP_SCORE_W_VOLATILITY;
  return clamp(Number(score.toFixed(2)), 0, 100);
}

function meetsMinimumSignalCriteria(stressed) {
  const hqs             = safeNum(stressed.hqsScore, 0);
  const features        = stressed.features || {};
  const oppScore        = calculateOpportunityScore({ hqsScore: hqs, ...features });
  const oppStrength     = safeNum(stressed.orchestrator?.opportunityStrength, 0);

  return (
    hqs         >= MIN_HQS_SCORE           &&
    oppScore    >= MIN_OPPORTUNITY_SCORE   &&
    oppStrength >= MIN_OPPORTUNITY_STRENGTH
  );
}

/* =========================================================
   PHANTOM SCENARIO DEFINITIONS
========================================================= */

/**
 * Each scenario is a pure-function transform that receives a snapshot and
 * returns a stressed variant.  All stress factors are deterministic (unlike
 * the random factors used in the regular 5-15 % stress engine) so that the
 * results are reproducible.
 */
const BLACK_SWAN_SCENARIOS = [
  {
    id:          "FLASH_CRASH",
    label:       "Flash-Crash (-20% Kurs, -30% Volumen)",
    description: "Plötzlicher Kurseinbruch innerhalb einer Sitzung.",
    apply(snapshot) {
      const f = snapshot.features || {};
      const sig = snapshot.signalContext || {};
      const orc = snapshot.orchestrator || {};
      return {
        hqsScore: safeNum(snapshot.hqsScore, 0) * 0.82,
        features: {
          momentum:       Math.max(0, safeNum(f.momentum, 0)       * 0.55),
          quality:        safeNum(f.quality, 0),
          stability:      safeNum(f.stability, 0)                   * 0.75,
          relative:       Math.max(0, safeNum(f.relative, 0)       * 0.70),
          volatility:     Math.min(1, safeNum(f.volatility, 0)     * 1.80),
          trendStrength:  Math.max(0, safeNum(f.trendStrength, 0)  * 0.50),
          relativeVolume: Math.max(0, safeNum(f.relativeVolume, 0) * 0.70),
          liquidityScore: Math.max(0, safeNum(f.liquidityScore, 0) * 0.70),
        },
        signalContext: {
          signalStrength:       Math.max(0, safeNum(sig.signalStrength, 0)       * 0.60),
          trendScore:           Math.max(0, safeNum(sig.trendScore, 0)           * 0.60),
          signalDirectionScore: safeNum(sig.signalDirectionScore, 0),
          signalConfidence:     safeNum(sig.signalConfidence, 0)                 * 0.70,
          buzzScore:            Math.max(0, safeNum(sig.buzzScore, 0)            * 0.70),
          sentimentScore:       safeNum(sig.sentimentScore, 0),
        },
        orchestrator: {
          opportunityStrength:     Math.max(0, safeNum(orc.opportunityStrength, 0)     * 0.65),
          orchestratorConfidence:  Math.max(0, safeNum(orc.orchestratorConfidence, 0)  * 0.65),
        },
        entryPrice: Math.max(0, safeNum(snapshot.entryPrice, 0) * 0.80),
      };
    },
  },

  {
    id:          "SECTOR_CONTAGION",
    label:       "Sektor-Ansteckung (-25% Branchenabsturz)",
    description: "Sektor-Leader bricht ein und reißt Mitbewerber mit.",
    apply(snapshot) {
      const f = snapshot.features || {};
      const sig = snapshot.signalContext || {};
      const orc = snapshot.orchestrator || {};
      return {
        hqsScore: safeNum(snapshot.hqsScore, 0) * 0.78,
        features: {
          momentum:       Math.max(0, safeNum(f.momentum, 0)       * 0.50),
          quality:        safeNum(f.quality, 0)                     * 0.85,
          stability:      safeNum(f.stability, 0)                   * 0.70,
          relative:       Math.max(0, safeNum(f.relative, 0)       * 0.60),
          volatility:     Math.min(1, safeNum(f.volatility, 0)     * 1.60),
          trendStrength:  Math.max(0, safeNum(f.trendStrength, 0)  * 0.45),
          relativeVolume: Math.max(0, safeNum(f.relativeVolume, 0) * 0.75),
          liquidityScore: Math.max(0, safeNum(f.liquidityScore, 0) * 0.80),
        },
        signalContext: {
          signalStrength:       Math.max(0, safeNum(sig.signalStrength, 0)       * 0.55),
          trendScore:           Math.max(0, safeNum(sig.trendScore, 0)           * 0.55),
          signalDirectionScore: safeNum(sig.signalDirectionScore, 0),
          signalConfidence:     safeNum(sig.signalConfidence, 0)                 * 0.65,
          buzzScore:            Math.max(0, safeNum(sig.buzzScore, 0)            * 0.60),
          sentimentScore:       safeNum(sig.sentimentScore, 0),
        },
        orchestrator: {
          opportunityStrength:     Math.max(0, safeNum(orc.opportunityStrength, 0)     * 0.60),
          orchestratorConfidence:  Math.max(0, safeNum(orc.orchestratorConfidence, 0)  * 0.60),
        },
        entryPrice: Math.max(0, safeNum(snapshot.entryPrice, 0) * 0.75),
      };
    },
  },

  {
    id:          "LIQUIDITY_CRISIS",
    label:       "Liquiditätskrise (-70% Handelsvolumen)",
    description: "Orderbuch kollabiert; Spreads explodieren.",
    apply(snapshot) {
      const f = snapshot.features || {};
      const sig = snapshot.signalContext || {};
      const orc = snapshot.orchestrator || {};
      return {
        hqsScore: safeNum(snapshot.hqsScore, 0) * 0.88,
        features: {
          momentum:       safeNum(f.momentum, 0),
          quality:        safeNum(f.quality, 0),
          stability:      safeNum(f.stability, 0)                   * 0.60,
          relative:       Math.max(0, safeNum(f.relative, 0)       * 0.50),
          volatility:     Math.min(1, safeNum(f.volatility, 0)     * 2.00),
          trendStrength:  safeNum(f.trendStrength, 0),
          relativeVolume: Math.max(0, safeNum(f.relativeVolume, 0) * 0.30),
          liquidityScore: Math.max(0, safeNum(f.liquidityScore, 0) * 0.30),
        },
        signalContext: {
          signalStrength:       Math.max(0, safeNum(sig.signalStrength, 0)       * 0.70),
          trendScore:           safeNum(sig.trendScore, 0),
          signalDirectionScore: safeNum(sig.signalDirectionScore, 0),
          signalConfidence:     safeNum(sig.signalConfidence, 0)                 * 0.55,
          buzzScore:            Math.max(0, safeNum(sig.buzzScore, 0)            * 0.30),
          sentimentScore:       safeNum(sig.sentimentScore, 0),
        },
        orchestrator: {
          opportunityStrength:     Math.max(0, safeNum(orc.opportunityStrength, 0)     * 0.50),
          orchestratorConfidence:  Math.max(0, safeNum(orc.orchestratorConfidence, 0)  * 0.50),
        },
        entryPrice: safeNum(snapshot.entryPrice, 0),
      };
    },
  },

  {
    id:          "RATE_SHOCK",
    label:       "Zinsschock (+300 Basispunkte)",
    description: "Überraschende Zinserhöhung der Notenbank.",
    apply(snapshot) {
      const f = snapshot.features || {};
      const sig = snapshot.signalContext || {};
      const orc = snapshot.orchestrator || {};
      return {
        hqsScore: safeNum(snapshot.hqsScore, 0) * 0.85,
        features: {
          momentum:       Math.max(0, safeNum(f.momentum, 0)       * 0.65),
          quality:        safeNum(f.quality, 0)                     * 0.75,
          stability:      safeNum(f.stability, 0)                   * 0.65,
          relative:       Math.max(0, safeNum(f.relative, 0)       * 0.70),
          volatility:     Math.min(1, safeNum(f.volatility, 0)     * 1.50),
          trendStrength:  Math.max(0, safeNum(f.trendStrength, 0)  * 0.60),
          relativeVolume: Math.max(0, safeNum(f.relativeVolume, 0) * 0.80),
          liquidityScore: Math.max(0, safeNum(f.liquidityScore, 0) * 0.80),
        },
        signalContext: {
          signalStrength:       Math.max(0, safeNum(sig.signalStrength, 0)       * 0.70),
          trendScore:           Math.max(0, safeNum(sig.trendScore, 0)           * 0.65),
          signalDirectionScore: safeNum(sig.signalDirectionScore, 0),
          signalConfidence:     safeNum(sig.signalConfidence, 0)                 * 0.70,
          buzzScore:            Math.max(0, safeNum(sig.buzzScore, 0)            * 0.75),
          sentimentScore:       safeNum(sig.sentimentScore, 0),
        },
        orchestrator: {
          opportunityStrength:     Math.max(0, safeNum(orc.opportunityStrength, 0)     * 0.72),
          orchestratorConfidence:  Math.max(0, safeNum(orc.orchestratorConfidence, 0)  * 0.72),
        },
        entryPrice: Math.max(0, safeNum(snapshot.entryPrice, 0) * 0.88),
      };
    },
  },

  {
    id:          "BLACK_SWAN",
    label:       "Schwarzer Schwan (-40% Kurs, -60% Volumen, -50% Momentum)",
    description: "Kombiniertes Extremszenario: Pandemie, Krieg, Marktcrash.",
    apply(snapshot) {
      const f = snapshot.features || {};
      const sig = snapshot.signalContext || {};
      const orc = snapshot.orchestrator || {};
      return {
        hqsScore: safeNum(snapshot.hqsScore, 0) * 0.55,
        features: {
          momentum:       Math.max(0, safeNum(f.momentum, 0)       * 0.35),
          quality:        safeNum(f.quality, 0)                     * 0.60,
          stability:      safeNum(f.stability, 0)                   * 0.45,
          relative:       Math.max(0, safeNum(f.relative, 0)       * 0.40),
          volatility:     Math.min(1, safeNum(f.volatility, 0)     * 2.50),
          trendStrength:  Math.max(0, safeNum(f.trendStrength, 0)  * 0.30),
          relativeVolume: Math.max(0, safeNum(f.relativeVolume, 0) * 0.40),
          liquidityScore: Math.max(0, safeNum(f.liquidityScore, 0) * 0.40),
        },
        signalContext: {
          signalStrength:       Math.max(0, safeNum(sig.signalStrength, 0)       * 0.40),
          trendScore:           Math.max(0, safeNum(sig.trendScore, 0)           * 0.35),
          signalDirectionScore: safeNum(sig.signalDirectionScore, 0),
          signalConfidence:     safeNum(sig.signalConfidence, 0)                 * 0.40,
          buzzScore:            Math.max(0, safeNum(sig.buzzScore, 0)            * 0.40),
          sentimentScore:       safeNum(sig.sentimentScore, 0),
        },
        orchestrator: {
          opportunityStrength:     Math.max(0, safeNum(orc.opportunityStrength, 0)     * 0.35),
          orchestratorConfidence:  Math.max(0, safeNum(orc.orchestratorConfidence, 0)  * 0.35),
        },
        entryPrice: Math.max(0, safeNum(snapshot.entryPrice, 0) * 0.60),
      };
    },
  },
];

/* =========================================================
   ANTIFRAGILITY THRESHOLD
   A stock is "antifragile" when it survives at least this fraction
   of the phantom scenarios.
========================================================= */

const ANTIFRAGILE_THRESHOLD = 0.6; // survives 3 of 5 scenarios

/* =========================================================
   CORE ENGINE
========================================================= */

/**
 * Runs all BLACK_SWAN_SCENARIOS against a single snapshot.
 *
 * @param {object} snapshot  - normalised opportunity snapshot
 *   Must contain: hqsScore, features, signalContext, orchestrator, entryPrice
 * @returns {{
 *   antifragilityScore: number,   // 0.0 – 1.0
 *   scenarioResults: Array<{ id, label, survived, stressedHqs }>,
 *   antifragile: boolean,
 *   survivedCount: number,
 *   totalScenarios: number
 * }}
 */
function runBlackSwanTest(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return {
      antifragilityScore: 0,
      scenarioResults: [],
      antifragile: false,
      survivedCount: 0,
      totalScenarios: BLACK_SWAN_SCENARIOS.length,
    };
  }

  const scenarioResults = BLACK_SWAN_SCENARIOS.map((scenario) => {
    let stressed;
    try {
      stressed = scenario.apply(snapshot);
    } catch (err) {
      logger.warn(`syntheticStressTest: scenario ${scenario.id} apply() error`, {
        message: err.message,
      });
      stressed = null;
    }

    const survived = stressed ? meetsMinimumSignalCriteria(stressed) : false;
    return {
      id:          scenario.id,
      label:       scenario.label,
      description: scenario.description,
      survived,
      stressedHqs: stressed ? Number(safeNum(stressed.hqsScore, 0).toFixed(1)) : 0,
    };
  });

  const survivedCount       = scenarioResults.filter((r) => r.survived).length;
  const antifragilityScore  = Number((survivedCount / BLACK_SWAN_SCENARIOS.length).toFixed(2));
  const antifragile         = antifragilityScore >= ANTIFRAGILE_THRESHOLD;

  return {
    antifragilityScore,
    scenarioResults,
    antifragile,
    survivedCount,
    totalScenarios: BLACK_SWAN_SCENARIOS.length,
  };
}

/**
 * Ranks an array of portfolio rows by antifragility.
 *
 * Each element must have a `symbol` field and either a pre-built
 * `snapshot` (the full opportunity snapshot object) or at minimum
 * `hqsScore`, `features`, etc. at the top level.
 *
 * @param {Array<object>} portfolioRows
 * @returns {Array<{
 *   symbol: string,
 *   antifragilityScore: number,
 *   antifragile: boolean,
 *   survivedCount: number,
 *   scenarioResults: Array
 * }>}
 */
function rankPortfolioAntifragility(portfolioRows) {
  if (!Array.isArray(portfolioRows) || !portfolioRows.length) return [];

  const results = portfolioRows.map((row) => {
    const snapshot = row.snapshot || row; // accept both wrapped and flat
    const result   = runBlackSwanTest(snapshot);
    return {
      symbol: String(row.symbol || snapshot.symbol || "UNKNOWN").toUpperCase(),
      ...result,
    };
  });

  return results.sort((a, b) => b.antifragilityScore - a.antifragilityScore);
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  runBlackSwanTest,
  rankPortfolioAntifragility,
  BLACK_SWAN_SCENARIOS,
  ANTIFRAGILE_THRESHOLD,
};
