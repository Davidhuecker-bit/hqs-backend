"use strict";

/*
  Agentic Debate Service  –  2035 Swarm Intelligence
  ----------------------------------------------------
  Every signal is internally evaluated by three independent agents:

    GROWTH_BIAS   – A momentum-optimist that favours signals with strong
                    trend and positive market direction.
    RISK_SKEPTIC  – A risk-pessimist that vetoes signals whenever key
                    danger markers (volatility, low robustness, volume
                    decline, bearish news) are present.
    MACRO_JUDGE   – A regime arbiter that weighs the macro-economic cluster
                    (Safe / Volatile / Danger) and inter-market early-warning
                    signals (BTC, Gold) to decide whether the environment
                    justifies releasing the signal.

  Consensus rule: a signal is only approved when at least 2 of the 3
  agents vote "approve".  A 1-0 minority is not enough.

  The debate result contains:
    - approved  (boolean)
    - approvalCount (0-3)
    - weightedApproval (0.0-1.0, uses dynamicWeights when provided)
    - votes     { growthBias, riskSkeptic, macroJudge }
    - debateSummary  – German one-liner describing the outcome
*/

/* =========================================================
   UTILS
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function norm0to1(x) {
  const n = safeNum(x, 0);
  if (n > 1.5) return Math.min(1, Math.max(0, n / 100));
  return Math.min(1, Math.max(0, n));
}

/* =========================================================
   AGENT THRESHOLDS  (named constants for tunability)
========================================================= */

// GROWTH_BIAS
const GROWTH_MIN_MOMENTUM   = 0.45; // minimum normalised momentum (0-1)
const GROWTH_MIN_OPP_SCORE  = 35;   // minimum opportunity score (0-100)

// RISK_SKEPTIC
const RISK_MAX_VOLATILITY   = 0.70; // above this = high volatility veto
const RISK_MIN_ROBUSTNESS   = 0.35; // below this = low robustness veto
const RISK_MIN_BUZZ         = 25;   // below this = volume/interest declining

// RISK_SKEPTIC – sector-alert tightening (15 %)
const RISK_SECTOR_ALERT_FACTOR = 0.85; // multiply thresholds by this when sectorAlert=true

// RISK_SKEPTIC – pattern memory influence
// When a pattern's historical 24h hit-rate is below PATTERN_WEAK_THRESHOLD and the
// sample size is large enough to be trustworthy, the robustness floor is raised by
// PATTERN_ROBUSTNESS_PENALTY to make the skeptic harder to satisfy.
const PATTERN_MIN_SAMPLE           = 5;    // min samples needed before applying penalty
const PATTERN_WEAK_THRESHOLD       = 0.35; // hitRate24h below this = historically poor pattern
const PATTERN_STRONG_THRESHOLD     = 0.65; // hitRate24h above this = historically strong pattern
const PATTERN_ROBUSTNESS_PENALTY   = 0.05; // raise robustness floor for weak patterns

// MACRO_JUDGE
const MACRO_EARLYWARNING_MIN_CONVICTION = 72; // override threshold when BTC+Gold warn
const MACRO_DANGER_MIN_CONVICTION       = 75; // min conviction to approve in Danger cluster
const MACRO_VOLATILE_MIN_CONVICTION     = 58; // min conviction in Volatile cluster
const MACRO_VOLATILE_MIN_HQS            = 48; // min HQS in Volatile cluster
const MACRO_SAFE_MIN_HQS                = 42; // min HQS in Safe cluster

/* =========================================================
   FILTER 1 – GROWTH_BIAS
========================================================= */

/**
 * Optimistic momentum agent.
 * Approves when the signal shows sufficient momentum, positive trend, and
 * a non-bearish directional reading.
 *
 * @param {object} opportunity   - built opportunity object
 * @param {object|null} signalContext
 * @returns {{ agent: string, vote: "approve"|"reject", reason: string }}
 */
function runGrowthBias(opportunity, signalContext) {
  const agent = "GROWTH_BIAS";
  const momentum = norm0to1(opportunity?.momentum ?? opportunity?.features?.momentum);
  const trend = safeNum(opportunity?.trend, 0);
  const oppScore = safeNum(opportunity?.opportunityScore, 0);
  const sigDirection = String(signalContext?.signalDirection || "neutral");

  const problems = [];
  if (momentum < GROWTH_MIN_MOMENTUM)
    problems.push(`schwaches Momentum (${(momentum * 100).toFixed(0)}%)`);
  if (trend < 0)
    problems.push("negativer Trend");
  if (sigDirection === "bearish")
    problems.push("bearisches Kurssignal");
  if (oppScore < GROWTH_MIN_OPP_SCORE)
    problems.push(`geringer Opportunity-Score (${oppScore.toFixed(0)})`);

  if (problems.length === 0) {
    return {
      agent,
      vote: "approve",
      forecastDirection: "bullish",
      reason: `Wachstums-Bias: Momentum ${(momentum * 100).toFixed(0)}%, Trend positiv, Signal ${sigDirection}`,
    };
  }

  return {
    agent,
    vote: "reject",
    forecastDirection: "bearish",
    reason: `Wachstums-Bias stimmte gegen Kauf wegen ${problems.join("; ")}`,
  };
}

/* =========================================================
   FILTER 2 – RISK_SKEPTIC
========================================================= */

/**
 * Build a short annotation string that describes what the Pattern Memory
 * context says about this type of setup.  Returns an empty string when
 * no relevant context is available.
 *
 * @param {object|null} patternContext  - result of getPatternStats()
 * @returns {string}
 */
function buildPatternNote(patternContext) {
  if (!patternContext || safeNum(patternContext?.sampleSize, 0) < PATTERN_MIN_SAMPLE) {
    return "";
  }
  const hitRate = patternContext?.hitRate24h;
  if (!Number.isFinite(hitRate)) return "";

  const pct = `${(hitRate * 100).toFixed(0)}%`;
  const n   = patternContext.sampleSize;

  if (hitRate < PATTERN_WEAK_THRESHOLD) {
    return ` ⚠️ Muster-Gedächtnis: schwache Historik (${pct}, n=${n})`;
  }
  if (hitRate > PATTERN_STRONG_THRESHOLD) {
    return ` ✅ Muster-Gedächtnis: starke Historik (${pct}, n=${n})`;
  }
  return "";
}

/**
 * Pessimistic risk agent.
 * Vetoes the signal when any of the classic danger markers are present.
 * When sectorAlert is active the robustness bar is raised by 15 %.
 *
 * @param {object} opportunity
 * @param {object|null} signalContext
 * @param {{ sectorAlert?: boolean }} [agentOptions]
 * @returns {{ agent: string, vote: "approve"|"reject", reason: string }}
 */
function runRiskSkeptic(opportunity, signalContext, agentOptions = {}) {
  const agent = "RISK_SKEPTIC";
  const sectorAlert    = Boolean(agentOptions?.sectorAlert);
  const patternContext = agentOptions?.patternContext || null;

  const volatility   = safeNum(opportunity?.volatility, 0);
  const robustness   = safeNum(opportunity?.robustnessScore, 0);
  const buzzScore    = safeNum(signalContext?.buzzScore, 50);
  const sigDirection = String(signalContext?.signalDirection || "neutral");

  // When a sector coherence alert is active, tighten the robustness floor
  const sectorAdjustedBase = sectorAlert
    ? RISK_MIN_ROBUSTNESS / RISK_SECTOR_ALERT_FACTOR  // higher minimum (harder to approve)
    : RISK_MIN_ROBUSTNESS;

  const effectiveMaxVolatility = sectorAlert
    ? RISK_MAX_VOLATILITY * RISK_SECTOR_ALERT_FACTOR  // lower ceiling (less tolerance)
    : RISK_MAX_VOLATILITY;

  // Pattern memory: if this type of setup historically performs poorly, raise the bar
  const patternPenalty =
    patternContext !== null &&
    safeNum(patternContext?.sampleSize, 0) >= PATTERN_MIN_SAMPLE &&
    Number.isFinite(patternContext?.hitRate24h) &&
    patternContext.hitRate24h < PATTERN_WEAK_THRESHOLD
      ? PATTERN_ROBUSTNESS_PENALTY
      : 0;

  const effectiveMinRobustness = sectorAdjustedBase + patternPenalty;

  const problems = [];
  if (volatility > effectiveMaxVolatility)
    problems.push(`hohe Volatilität (${(volatility * 100).toFixed(0)}%)`);
  if (robustness < effectiveMinRobustness)
    problems.push(`niedrige Robustheit (${(robustness * 100).toFixed(0)}%)`);
  if (sigDirection === "bearish")
    problems.push("bearische Nachrichtenlage");
  if (buzzScore < RISK_MIN_BUZZ)
    problems.push(`sinkendes Volumen (Buzz ${buzzScore.toFixed(0)})`);

  // Build optional pattern memory annotation for the reason string
  const patternNote = buildPatternNote(patternContext);

  if (sectorAlert && problems.length === 0) {
    return {
      agent,
      vote: "approve",
      forecastDirection: "neutral",
      reason: `Risiko-Skeptiker: Kennzahlen akzeptabel – ⚠️ Sektor-Alarm aktiv, verschärfte Schwellen bestanden (Robustheit ${(robustness * 100).toFixed(0)}%, Vol ${(volatility * 100).toFixed(0)}%)${patternNote}`,
    };
  }

  if (problems.length === 0) {
    return {
      agent,
      vote: "approve",
      forecastDirection: "neutral",
      reason: `Risiko-Skeptiker: Kennzahlen akzeptabel (Robustheit ${(robustness * 100).toFixed(0)}%, Vol ${(volatility * 100).toFixed(0)}%)${patternNote}`,
    };
  }

  return {
    agent,
    vote: "reject",
    forecastDirection: "bearish",
    reason: `Risiko-Skeptiker stimmte gegen Kauf wegen ${problems.join("; ")}${patternNote}`,
  };
}

/* =========================================================
   FILTER 3 – MACRO_JUDGE
========================================================= */

/**
 * Macro regime arbiter.
 * Considers the overall market cluster and the BTC/Gold early-warning
 * indicator to evaluate whether the macro environment allows the signal.
 *
 * @param {object} opportunity
 * @param {string} marketCluster  'Safe' | 'Volatile' | 'Danger'
 * @param {object|null} interMarketData  result of getInterMarketCorrelation()
 * @returns {{ agent: string, vote: "approve"|"reject", reason: string }}
 */
function runMacroJudge(opportunity, marketCluster, interMarketData) {
  const agent = "MACRO_JUDGE";
  const conviction = safeNum(opportunity?.finalConviction, 0);
  const hqsScore = safeNum(opportunity?.hqsScore, 0);
  const earlyWarning = Boolean(interMarketData?.earlyWarning);
  const btcSignal = interMarketData?.btc?.signal || "neutral";
  const goldSignal = interMarketData?.gold?.signal || "neutral";

  // BTC + Gold both bearish → macro risk-off precursor
  if (earlyWarning) {
    if (conviction >= MACRO_EARLYWARNING_MIN_CONVICTION) {
      return {
        agent,
        vote: "approve",
        forecastDirection: "bullish",
        reason: `Makro-Richter: BTC/Gold zeigen Risikoabbau, aber hohe Überzeugung (${conviction.toFixed(0)}) rechtfertigt Freigabe`,
      };
    }
    return {
      agent,
      vote: "reject",
      forecastDirection: "bearish",
      reason: `Makro-Richter gab Recht: BTC ${btcSignal}, Gold ${goldSignal} – Frühwarnsignal aktiv; Überzeugung (${conviction.toFixed(0)}) zu gering`,
    };
  }

  if (marketCluster === "Danger") {
    if (conviction >= MACRO_DANGER_MIN_CONVICTION) {
      return {
        agent,
        vote: "approve",
        forecastDirection: "bullish",
        reason: `Makro-Richter: Gefahrenmarkt, starke Überzeugung (${conviction.toFixed(0)}) erlaubt Freigabe`,
      };
    }
    return {
      agent,
      vote: "reject",
      forecastDirection: "bearish",
      reason: `Makro-Richter gab Recht: Marktumfeld kritisch (${marketCluster}), Überzeugung (${conviction.toFixed(0)}) unzureichend – Entscheidung: Schutzmodus`,
    };
  }

  if (marketCluster === "Volatile") {
    if (conviction >= MACRO_VOLATILE_MIN_CONVICTION && hqsScore >= MACRO_VOLATILE_MIN_HQS) {
      return {
        agent,
        vote: "approve",
        forecastDirection: "bullish",
        reason: `Makro-Richter: Volatiler Markt, gute Basis (HQS ${hqsScore.toFixed(0)}, Überzeugung ${conviction.toFixed(0)})`,
      };
    }
    return {
      agent,
      vote: "reject",
      forecastDirection: "bearish",
      reason: `Makro-Richter: Volatiles Umfeld zu riskant (HQS ${hqsScore.toFixed(0)}, Überzeugung ${conviction.toFixed(0)})`,
    };
  }

  // Safe cluster
  if (hqsScore >= MACRO_SAFE_MIN_HQS) {
    return {
      agent,
      vote: "approve",
      forecastDirection: "bullish",
      reason: `Makro-Richter: Konstruktives Umfeld, HQS-Score (${hqsScore.toFixed(0)}) ausreichend`,
    };
  }

  return {
    agent,
    vote: "reject",
    forecastDirection: "bearish",
    reason: `Makro-Richter: Trotz sicherem Markt unzureichende Qualität (HQS ${hqsScore.toFixed(0)})`,
  };
}

/* =========================================================
   DEBATE ORCHESTRATOR
========================================================= */

/**
 * Runs the full 3-agent debate for a single signal.
 *
 * @param {object} opportunity    - built opportunity object
 * @param {string} marketCluster  - 'Safe' | 'Volatile' | 'Danger'
 * @param {object|null} signalContext
 * @param {object|null} interMarketData  - result of getInterMarketCorrelation()
 * @param {object} [options]
 * @param {object}  [options.dynamicWeights]  - per-agent weight map from causalMemory
 *   e.g. { GROWTH_BIAS: 0.38, RISK_SKEPTIC: 0.34, MACRO_JUDGE: 0.28 }
 *   When provided the weighted approval sum must exceed 0.5 to approve.
 * @param {string|null} [options.metaRationale]  - historical context sentence from
 *   causalMemory.buildMetaRationale(); prepended to debateSummary when present.
 * @param {boolean} [options.sectorAlert]  - when true the RISK_SKEPTIC uses tighter
 *   thresholds (sector coherence sharpening active).
 * @returns {{
 *   approved: boolean,
 *   approvalCount: number,
 *   weightedApproval: number,
 *   votes: { growthBias: object, riskSkeptic: object, macroJudge: object },
 *   debateSummary: string
 * }}
 */
function runAgenticDebate(
  opportunity,
  marketCluster,
  signalContext,
  interMarketData,
  options = {}
) {
  const { dynamicWeights = null, metaRationale = null, sectorAlert = false, patternContext = null } = options;

  const growthBias  = runGrowthBias(opportunity, signalContext);
  const riskSkeptic = runRiskSkeptic(opportunity, signalContext, { sectorAlert, patternContext });
  const macroJudge  = runMacroJudge(opportunity, marketCluster, interMarketData);

  // --- Simple majority (unchanged legacy behaviour) ---
  const agents        = [growthBias, riskSkeptic, macroJudge];
  const approvalCount = agents.filter((a) => a.vote === "approve").length;

  // --- Weighted approval (new: uses dynamicWeights when available) ---
  const DEFAULT_W = 1 / 3;
  const wGrowth  = safeNum(dynamicWeights?.GROWTH_BIAS,  DEFAULT_W);
  const wSkeptic = safeNum(dynamicWeights?.RISK_SKEPTIC, DEFAULT_W);
  const wMacro   = safeNum(dynamicWeights?.MACRO_JUDGE,  DEFAULT_W);

  const weightedApproval =
    (growthBias.vote  === "approve" ? wGrowth  : 0) +
    (riskSkeptic.vote === "approve" ? wSkeptic : 0) +
    (macroJudge.vote  === "approve" ? wMacro   : 0);

  // With equal weights (1/3 each) approving agents need a weighted sum > 0.5,
  // which requires at least 2 agents (2 × 1/3 ≈ 0.667 > 0.5), preserving the
  // legacy "2-of-3 consensus" behaviour.  Dynamic weights may shift this balance
  // while keeping the threshold fixed at > 0.5.
  const WEIGHTED_APPROVAL_THRESHOLD = 0.5;
  const approved = weightedApproval > WEIGHTED_APPROVAL_THRESHOLD;

  const debateSummary = buildDebateSummary(
    growthBias,
    riskSkeptic,
    macroJudge,
    approved,
    metaRationale,
    patternContext
  );

  return {
    approved,
    approvalCount,
    weightedApproval: Number(weightedApproval.toFixed(4)),
    votes: {
      growthBias,
      riskSkeptic,
      macroJudge,
    },
    debateSummary,
  };
}

/* =========================================================
   DEBATE SUMMARY BUILDER (German rationale)
========================================================= */

/**
 * Generates a concise German summary of the internal debate,
 * naming which agents approved or rejected and why.
 * When metaRationale is provided it is prepended to give historical context.
 *
 * @param {object} growthBias
 * @param {object} riskSkeptic
 * @param {object} macroJudge
 * @param {boolean} approved
 * @param {string|null} [metaRationale]
 */
function buildDebateSummary(growthBias, riskSkeptic, macroJudge, approved, metaRationale = null, patternContext = null) {
  const parts = [];

  // Historical context from CausalMemory (Meta-Rationale)
  if (metaRationale && typeof metaRationale === "string" && metaRationale.trim()) {
    parts.push(metaRationale.trim());
  }

  // Pattern Memory context: summarise historical performance for this setup type
  if (
    patternContext !== null &&
    safeNum(patternContext?.sampleSize, 0) >= PATTERN_MIN_SAMPLE
  ) {
    const hitStr = Number.isFinite(patternContext?.hitRate24h)
      ? `${(patternContext.hitRate24h * 100).toFixed(0)}%`
      : "n/a";
    const hit7dStr = Number.isFinite(patternContext?.hitRate7d)
      ? `, 7d: ${(patternContext.hitRate7d * 100).toFixed(0)}%`
      : "";
    parts.push(
      `🧠 Pattern-Memory: n=${patternContext.sampleSize}, 24h-Trefferquote ${hitStr}${hit7dStr}`
    );
  }

  // Always include the rejections first (most informative)
  const rejects = [growthBias, riskSkeptic, macroJudge].filter(
    (a) => a.vote === "reject"
  );
  const approves = [growthBias, riskSkeptic, macroJudge].filter(
    (a) => a.vote === "approve"
  );

  for (const a of rejects) {
    parts.push(a.reason);
  }
  for (const a of approves) {
    parts.push(a.reason);
  }

  const verdict = approved
    ? "Entscheidung: Signal freigegeben (2/3 Konsens)."
    : "Entscheidung: Schutzmodus (kein 2/3 Konsens).";

  parts.push(verdict);

  return parts.join(" | ");
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  runAgenticDebate,
  runGrowthBias,
  runRiskSkeptic,
  runMacroJudge,
};
