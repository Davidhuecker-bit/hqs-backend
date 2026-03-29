"use strict";

// engines/maturityClassification.js
// Shared maturity classification helpers for admin engines.
// Provides consistent logic for differentiating natural early-phase
// data growth from genuine hard data problems.

/**
 * Ratio of symbols with hard data problems that triggers a "genuine problem"
 * classification instead of "natural early phase".
 */
const HARD_DATA_PROBLEM_RATIO = 0.5;

/**
 * Ratio of seed+early symbols that indicates the system is in a natural
 * early build-up phase (not a hard failure).
 */
const EARLY_PHASE_DOMINANT_RATIO = 0.5;

/**
 * Classify the maturity situation into one of four phases.
 *
 * @param {object|null} maturitySummary – aggregate maturity data from buildMarketSnapshot()
 * @returns {{ phase: string, earlyPhaseCount: number, devCount: number, matCount: number, hardProblems: number, total: number }}
 *
 *  phase values:
 *   "hard_problems"   – genuine data pipeline issues dominate
 *   "early_phase"     – mostly seed/early symbols, natural growth
 *   "developing"      – mix with developing symbols, growing confidence
 *   "unknown"         – no maturitySummary available (fallback)
 */
function classifyMaturityPhase(maturitySummary) {
  if (!maturitySummary || !maturitySummary.total || maturitySummary.total === 0) {
    return { phase: "unknown", earlyPhaseCount: 0, devCount: 0, matCount: 0, hardProblems: 0, total: 0 };
  }

  const ms = maturitySummary;
  const total = ms.total;
  const hardProblems = ms.hardDataProblems || 0;
  const seedCount = ms.seed || 0;
  const earlyCount = ms.early || 0;
  const devCount = ms.developing || 0;
  const matCount = ms.mature || 0;
  const earlyPhaseCount = seedCount + earlyCount;

  let phase;
  if (hardProblems > total * HARD_DATA_PROBLEM_RATIO) {
    phase = "hard_problems";
  } else if (earlyPhaseCount > total * EARLY_PHASE_DOMINANT_RATIO) {
    phase = "early_phase";
  } else if (devCount > 0) {
    phase = "developing";
  } else {
    phase = "unknown";
  }

  return { phase, earlyPhaseCount, devCount, matCount, hardProblems, total };
}

module.exports = {
  HARD_DATA_PROBLEM_RATIO,
  EARLY_PHASE_DOMINANT_RATIO,
  classifyMaturityPhase,
};
