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
 * Pessimistic risk agent.
 * Vetoes the signal when any of the classic danger markers are present.
 *
 * @param {object} opportunity
 * @param {object|null} signalContext
 * @returns {{ agent: string, vote: "approve"|"reject", reason: string }}
 */
function runRiskSkeptic(opportunity, signalContext) {
  const agent = "RISK_SKEPTIC";
  const volatility = safeNum(opportunity?.volatility, 0);
  const robustness = safeNum(opportunity?.robustnessScore, 0);
  const buzzScore = safeNum(signalContext?.buzzScore, 50);
  const sigDirection = String(signalContext?.signalDirection || "neutral");

  const problems = [];
  if (volatility > RISK_MAX_VOLATILITY)
    problems.push(`hohe Volatilität (${(volatility * 100).toFixed(0)}%)`);
  if (robustness < RISK_MIN_ROBUSTNESS)
    problems.push(`niedrige Robustheit (${(robustness * 100).toFixed(0)}%)`);
  if (sigDirection === "bearish")
    problems.push("bearische Nachrichtenlage");
  if (buzzScore < RISK_MIN_BUZZ)
    problems.push(`sinkendes Volumen (Buzz ${buzzScore.toFixed(0)})`);

  if (problems.length === 0) {
    return {
      agent,
      vote: "approve",
      forecastDirection: "neutral",
      reason: `Risiko-Skeptiker: Kennzahlen akzeptabel (Robustheit ${(robustness * 100).toFixed(0)}%, Vol ${(volatility * 100).toFixed(0)}%)`,
    };
  }

  return {
    agent,
    vote: "reject",
    forecastDirection: "bearish",
    reason: `Risiko-Skeptiker stimmte gegen Kauf wegen ${problems.join("; ")}`,
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
 * @returns {{
 *   approved: boolean,
 *   approvalCount: number,
 *   votes: { growthBias: object, riskSkeptic: object, macroJudge: object },
 *   debateSummary: string
 * }}
 */
function runAgenticDebate(
  opportunity,
  marketCluster,
  signalContext,
  interMarketData
) {
  const growthBias = runGrowthBias(opportunity, signalContext);
  const riskSkeptic = runRiskSkeptic(opportunity, signalContext);
  const macroJudge = runMacroJudge(opportunity, marketCluster, interMarketData);

  const agents = [growthBias, riskSkeptic, macroJudge];
  const approvalCount = agents.filter((a) => a.vote === "approve").length;
  const approved = approvalCount >= 2;

  const debateSummary = buildDebateSummary(
    growthBias,
    riskSkeptic,
    macroJudge,
    approved
  );

  return {
    approved,
    approvalCount,
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
 */
function buildDebateSummary(growthBias, riskSkeptic, macroJudge, approved) {
  const parts = [];

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
