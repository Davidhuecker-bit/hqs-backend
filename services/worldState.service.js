"use strict";

/*
  World State Service
  -------------------
  Assembles a unified, versioned global market truth layer from existing
  market fragments:

    - Regime Detection        → regime cluster, avgHqs, bearRatio, highVolRatio
    - Inter-Market (BTC/Gold) → cross-asset signals, earlyWarning
    - Sector Coherence        → sharpened sectors, active alerts
    - Causal Memory           → dynamic agent weights

  The world_state is persisted in the existing `learning_runtime_state` table
  under the key 'world_state' and cached in-memory for CACHE_TTL_MS.

  Consumers:
    - opportunityScanner.service.js  (replaces 3 individual calls)
    - GET /api/admin/world-state     (admin visibility)
    - future policy / capital-allocation layer
*/

const logger = require("../utils/logger");
const { classifyMarketRegime } = require("./regimeDetection.service");
const { getInterMarketCorrelation } = require("./interMarketCorrelation.service");
const { getSharpenedSectorSnapshot } = require("./sectorCoherence.service");
const { getAgentWeights } = require("./causalMemory.repository");
const {
  saveRuntimeState,
  loadRuntimeState,
} = require("./discoveryLearning.repository");

/* =========================================================
   CONSTANTS
========================================================= */

const WORLD_STATE_VERSION = 1;
const WORLD_STATE_KEY = "world_state";

// In-memory cache TTL: 2 minutes (short enough to stay fresh, long enough to
// avoid hammering the DB on every opportunity scan)
const CACHE_TTL_MS = 2 * 60 * 1000;

/* =========================================================
   IN-MEMORY CACHE
========================================================= */

let _cache = null;
let _cacheTs = 0;

function _getCached() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL_MS) return _cache;
  return null;
}

function _setCache(value) {
  _cache = value;
  _cacheTs = Date.now();
}

/* =========================================================
   DERIVED FIELD HELPERS
========================================================= */

/**
 * Derives risk_mode from regime cluster and cross-asset early warning.
 *   risk_off : Danger regime OR cross-asset earlyWarning active
 *   neutral  : Volatile regime
 *   risk_on  : Safe regime with no early warning
 *
 * @param {"Safe"|"Volatile"|"Danger"} cluster
 * @param {boolean} earlyWarning
 * @returns {"risk_on"|"neutral"|"risk_off"}
 */
function deriveRiskMode(cluster, earlyWarning) {
  if (cluster === "Danger" || earlyWarning) return "risk_off";
  if (cluster === "Volatile") return "neutral";
  return "risk_on";
}

/**
 * Derives a volatility state label from the high-volatility ratio.
 *   high     : >= 45 % of symbols above vol threshold
 *   elevated : >= 20 %
 *   low      : below 20 %
 *
 * @param {number} highVolRatio  0–1
 * @returns {"low"|"elevated"|"high"}
 */
function deriveVolatilityState(highVolRatio) {
  if (highVolRatio >= 0.45) return "high";
  if (highVolRatio >= 0.20) return "elevated";
  return "low";
}

/**
 * Computes a 0–1 composite uncertainty score.
 * Higher = more uncertain / riskier conditions.
 *
 * @param {object} p
 * @param {number}  p.bearRatio
 * @param {number}  p.highVolRatio
 * @param {boolean} p.earlyWarning
 * @param {number}  p.activeSectorAlerts
 * @returns {number}
 */
function deriveUncertainty({ bearRatio, highVolRatio, earlyWarning, activeSectorAlerts }) {
  const base = Math.min(1, (bearRatio || 0) * 0.5 + (highVolRatio || 0) * 0.5);
  const warningBoost = earlyWarning ? 0.15 : 0;
  const sectorBoost = activeSectorAlerts > 0
    ? Math.min(0.10, activeSectorAlerts * 0.05)
    : 0;
  return Math.min(1, parseFloat((base + warningBoost + sectorBoost).toFixed(4)));
}

/**
 * Builds a concise human-readable summary of the current global state.
 */
function buildSourceSummary(cluster, riskMode, earlyWarning, activeSectorAlerts) {
  const parts = [`Regime: ${cluster}`, `Risk-Mode: ${riskMode}`];
  if (earlyWarning) parts.push("⚠ Cross-Asset Early Warning aktiv");
  if (activeSectorAlerts > 0) parts.push(`${activeSectorAlerts} Sektor(en) in Alert`);
  return parts.join(" | ");
}

/* =========================================================
   BUILD
========================================================= */

/**
 * Assembles a fresh world_state from all available data sources.
 * Each source degrades gracefully; failures are recorded in fallbacks_used.
 *
 * Persists the result to learning_runtime_state['world_state'] and updates the
 * in-memory cache.
 *
 * @returns {Promise<WorldStateObject>}
 */
async function buildWorldState() {
  const fallbacksUsed = [];
  const sources = {
    regime:      false,
    cross_asset: false,
    sector:      false,
    agents:      false,
  };

  // ── 1. Regime Detection ─────────────────────────────────────────────────
  let regime = {
    cluster: "Safe",
    avgHqs: 0,
    bearRatio: 0,
    highVolRatio: 0,
    totalSymbols: 0,
  };
  try {
    regime = await classifyMarketRegime();
    sources.regime = true;
  } catch (err) {
    fallbacksUsed.push("regime:fallback_safe");
    logger.warn("worldState: regime detection failed – using Safe fallback", {
      message: err.message,
    });
  }

  // ── 2. Cross-Asset / Inter-Market (BTC + Gold) ──────────────────────────
  let crossAssetState = { btc: null, gold: null, earlyWarning: false };
  try {
    const raw = await getInterMarketCorrelation();
    crossAssetState = {
      btc: raw.btc
        ? { signal: raw.btc.signal, change24h: raw.btc.change24h, price: raw.btc.price }
        : null,
      gold: raw.gold
        ? { signal: raw.gold.signal, change24h: raw.gold.change24h, price: raw.gold.price }
        : null,
      earlyWarning: Boolean(raw.earlyWarning),
    };
    sources.cross_asset = true;
  } catch (err) {
    fallbacksUsed.push("cross_asset:unavailable");
    logger.warn("worldState: inter-market fetch failed – cross_asset unavailable", {
      message: err.message,
    });
  }

  // ── 3. Sector Coherence ─────────────────────────────────────────────────
  let sharpenedSectors = [];
  try {
    sharpenedSectors = getSharpenedSectorSnapshot();
    sources.sector = true;
  } catch (err) {
    fallbacksUsed.push("sector:fallback_empty");
    logger.warn("worldState: sector coherence snapshot failed", {
      message: err.message,
    });
  }

  // ── 4. Agent Calibration (Causal Memory / Dynamic Weights) ──────────────
  let agentWeights = { GROWTH_BIAS: 1, RISK_SKEPTIC: 1, MACRO_JUDGE: 1 };
  try {
    agentWeights = await getAgentWeights();
    sources.agents = true;
  } catch (err) {
    fallbacksUsed.push("agents:default_weights");
    logger.warn("worldState: agent weights fetch failed – using defaults", {
      message: err.message,
    });
  }

  // ── Derived fields ───────────────────────────────────────────────────────
  const earlyWarning = crossAssetState.earlyWarning;
  const activeSectorAlerts = sharpenedSectors.length;
  const riskMode = deriveRiskMode(regime.cluster, earlyWarning);
  const volatilityState = deriveVolatilityState(regime.highVolRatio);
  const uncertainty = deriveUncertainty({
    bearRatio:          regime.bearRatio,
    highVolRatio:       regime.highVolRatio,
    earlyWarning,
    activeSectorAlerts,
  });

  // ── Assemble world_state ─────────────────────────────────────────────────
  const complete =
    sources.regime && sources.cross_asset && sources.sector && sources.agents;

  const worldState = {
    version:          WORLD_STATE_VERSION,
    created_at:       new Date().toISOString(),
    regime: {
      cluster:      regime.cluster,
      avgHqs:       regime.avgHqs,
      bearRatio:    regime.bearRatio,
      highVolRatio: regime.highVolRatio,
      totalSymbols: regime.totalSymbols,
    },
    risk_mode:        riskMode,
    volatility_state: volatilityState,
    cross_asset_state: crossAssetState,
    sector_stress: {
      sharpenedSectors,
      activeSectorAlerts,
    },
    agent_calibration: {
      weights: agentWeights,
    },
    uncertainty,
    source_summary: buildSourceSummary(
      regime.cluster,
      riskMode,
      earlyWarning,
      activeSectorAlerts
    ),
    sources,
    complete,
    fallbacks_used: fallbacksUsed,
  };

  // ── Persist to learning_runtime_state ────────────────────────────────────
  try {
    await saveRuntimeState(WORLD_STATE_KEY, worldState);
  } catch (persistErr) {
    logger.warn("worldState: persistence failed – world_state not stored to DB", {
      message: persistErr.message,
    });
  }

  _setCache(worldState);

  logger.info("worldState: built and cached", {
    regime:           regime.cluster,
    risk_mode:        riskMode,
    volatility_state: volatilityState,
    earlyWarning,
    activeSectorAlerts,
    uncertainty,
    complete,
    fallbacksUsed:    fallbacksUsed.length > 0 ? fallbacksUsed : "none",
  });

  return worldState;
}

/* =========================================================
   PUBLIC API
========================================================= */

/**
 * Returns the current world_state.
 *
 * Priority:
 *   1. In-memory cache  (if < 2 min old)
 *   2. Persisted DB snapshot  (triggers background rebuild)
 *   3. Full synchronous rebuild  (cold start)
 *
 * @returns {Promise<WorldStateObject>}
 */
async function getWorldState() {
  const cached = _getCached();
  if (cached) return cached;

  // Try loading last persisted snapshot while triggering a background rebuild
  try {
    const persisted = await loadRuntimeState(WORLD_STATE_KEY);
    if (persisted && persisted.version) {
      _setCache(persisted);
      // Rebuild asynchronously so the next call gets a fresh snapshot
      buildWorldState().catch((err) =>
        logger.warn("worldState: background rebuild failed", {
          message: err.message,
        })
      );
      return persisted;
    }
  } catch (_) {
    // Ignore – fall through to full synchronous build
  }

  // Cold-start: build synchronously
  return buildWorldState();
}

module.exports = {
  buildWorldState,
  getWorldState,
};
