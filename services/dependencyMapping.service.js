"use strict";

/**
 * Dependency Mapping Light V1
 * ───────────────────────────────────────────────────────────
 * A small, manually curated HQS relationship layer that
 * provides dependency hints for the Change Intelligence
 * analysis.
 *
 * Principles:
 *   – No DB, no AST parsing, no automatic graph engine
 *   – Purely in-memory, easily extendable
 *   – Defensive: always returns a safe, normalised structure
 *   – If nothing matches → empty hints (no-op)
 *
 * Exports:
 *   getDependencyHintsForFiles(changedFiles)
 *   getDependencyHintsForArea(area)
 *   getAllDependencyMappings()
 * ───────────────────────────────────────────────────────────
 */

/* ─────────────────────────────────────────────
   HQS Core Dependency Mappings
   ───────────────────────────────────────────── */

const DEPENDENCY_MAPPINGS = [
  /* A ── Admin / Routing / Frontend chain ─────────────── */
  {
    id: "admin_routes",
    matchers: [
      "routes/admin.routes.js",
      "admin.routes",
      "admin_routes",
    ],
    relatedFiles: [
      "src/services/api.js",
      "src/utils/adminMappers.js",
      "public/admin.html",
      "src/components/DashboardIntegrated.jsx",
    ],
    relatedAreas: [
      "admin_views",
      "api_layer",
      "admin_mappers",
    ],
    followupChecks: [
      "Verify API contract between backend route and frontend api.js calls",
      "Check if adminMappers still match the new response shape",
      "Confirm affected Admin-View(s) render correctly",
      "DashboardIntegrated.jsx may need matching updates",
    ],
    notes: "Admin route changes often cascade into API helpers, mappers and Admin-UI views.",
  },

  /* B ── HQS Assessment path ─────────────────────────── */
  {
    id: "hqs_assessment",
    matchers: [
      "hqs_assessment",
      "hqsAssessment",
      "assessment",
      "services/hqsAssessment",
    ],
    relatedFiles: [
      "src/utils/adminMappers.js",
      "engines/adminAlerts.engine.js",
      "engines/adminPriorities.engine.js",
      "engines/adminBriefing.engine.js",
    ],
    relatedAreas: [
      "admin_mappers",
      "filter_sort_logic",
      "summary_tiles",
      "card_ui_details",
    ],
    followupChecks: [
      "Check adminMappers for matching field transformations",
      "Verify filter and sort logic still works with changed assessment fields",
      "Confirm summary tiles / Kacheln display updated data correctly",
      "Check card-detail UI for changed field names or values",
    ],
    notes: "Assessment field changes affect mappers, filters, summary builders and UI cards.",
  },

  /* C ── Symbol sources (reference / demo portfolio) ─── */
  {
    id: "symbol_source",
    matchers: [
      "symbol_source",
      "symbolSource",
      "admin_reference_portfolio",
      "adminReferencePortfolio",
      "reference_portfolio",
      "demo_portfolio",
      "demoPortfolio",
      "universe_symbols",
      "entity_map",
    ],
    relatedFiles: [
      "services/adminReferencePortfolio.repository.js",
      "services/adminDemoPortfolio.service.js",
      "services/universe.repository.js",
      "services/entityMap.repository.js",
      "services/symbolSummary.builder.js",
    ],
    relatedAreas: [
      "universe_symbols",
      "snapshot_pipeline",
      "read_models",
      "ui_summary_paths",
    ],
    followupChecks: [
      "Ensure universe_symbols enrollment still works for changed symbols",
      "Verify snapshot scanner picks up new / changed symbols",
      "Check if symbol_summary / read-models need a rebuild",
      "Confirm Demo-Portfolio service reflects changes correctly",
    ],
    notes: "Symbol source changes cascade into universe jobs, snapshot pipeline and read-model rebuilds.",
  },

  /* D ── Snapshot / Pipeline cascade ─────────────────── */
  {
    id: "snapshot_pipeline",
    matchers: [
      "snapshot_pipeline",
      "snapshotPipeline",
      "market_snapshots",
      "marketSnapshots",
      "marketService",
      "services/marketService",
      "buildMarketSnapshot",
      "snapshot-scan",
    ],
    relatedFiles: [
      "services/marketService.js",
      "services/advancedMetrics.repository.js",
      "services/hqsScores.repository.js",
      "services/marketNews.repository.js",
      "services/outcomeTracking.service.js",
      "services/symbolSummary.builder.js",
    ],
    relatedAreas: [
      "market_snapshots",
      "market_advanced_metrics",
      "hqs_scores",
      "market_news",
      "outcome_tracking",
      "read_models",
    ],
    followupChecks: [
      "Check if advanced-metrics pipeline still receives correct snapshot data",
      "Verify hqs_scores computation is not broken by changed fields",
      "Confirm market_news enrichment still works",
      "outcome_tracking / symbol_summary may need rebuild after schema changes",
      "Check Admin / UI read-models for stale data",
    ],
    notes: "Snapshot/scoring/data-path changes cascade through the full pipeline: snapshots → metrics → scores → news → outcome → read-models.",
  },

  /* E ── Tech Radar ──────────────────────────────────── */
  {
    id: "tech_radar",
    matchers: [
      "tech_radar",
      "techRadar",
      "tech-radar",
      "services/techRadar",
    ],
    relatedFiles: [
      "services/techRadar.service.js",
      "src/utils/adminMappers.js",
    ],
    relatedAreas: [
      "admin_mappers",
      "filter_summary_ui",
      "status_badge_logic",
      "relevance_fit_assessment",
    ],
    followupChecks: [
      "Check adminMappers for matching Tech Radar field transformations",
      "Verify filter/summary UI still handles changed fields",
      "Confirm status/badge logic matches updated assessment values",
      "Check relevance/fit/assessment display in UI",
    ],
    notes: "Tech Radar assessment changes affect Admin Mapper, filter/summary UI and status/badge logic.",
  },

  /* F ── Change Memory / DeepSeek Admin ──────────────── */
  {
    id: "change_memory",
    matchers: [
      "change_memory",
      "changeMemory",
      "changeIntelligence",
      "change_intelligence",
      "deepseek_admin",
      "deepseekConsole",
      "adminDeepseekConsole",
      "dependencyMapping",
    ],
    relatedFiles: [
      "routes/admin.routes.js",
      "services/changeIntelligence.service.js",
      "services/changeMemory.repository.js",
      "services/adminDeepseekConsole.service.js",
      "services/dependencyMapping.service.js",
    ],
    relatedAreas: [
      "admin_routes",
      "deepseek_integration",
      "change_intelligence",
      "admin_views",
    ],
    followupChecks: [
      "Verify Change Intelligence endpoint still returns valid JSON",
      "Check if Change Memory persistence still works after route changes",
      "Confirm Admin DeepSeek Console modes are not broken",
      "If dependency mapping is changed, verify hints still merge cleanly",
    ],
    notes: "DeepSeek/Memory/Console area changes are tightly coupled – always verify the full chain.",
  },

  /* G ── Reference Portfolio (dedicated) ─────────────── */
  {
    id: "reference_portfolio",
    matchers: [
      "reference_portfolio",
      "referencePortfolio",
      "adminReferencePortfolio",
    ],
    relatedFiles: [
      "services/adminReferencePortfolio.repository.js",
      "services/universe.repository.js",
      "services/symbolSummary.builder.js",
    ],
    relatedAreas: [
      "universe_symbols",
      "snapshot_pipeline",
      "symbol_summary",
    ],
    followupChecks: [
      "Check universe_symbols enrollment for reference basket symbols",
      "Verify snapshot pipeline picks up reference portfolio changes",
      "Confirm symbol_summary is refreshed for affected symbols",
    ],
    notes: "Reference Portfolio is enrolled into universe_symbols (priority=10); changes cascade into snapshots and summaries.",
  },

  /* H ── Demo Portfolio (dedicated) ──────────────────── */
  {
    id: "demo_portfolio",
    matchers: [
      "demo_portfolio",
      "demoPortfolio",
      "adminDemoPortfolio",
      "uiDemoPortfolio",
    ],
    relatedFiles: [
      "services/adminDemoPortfolio.service.js",
      "services/symbolSummary.builder.js",
      "services/portfolioView.service.js",
    ],
    relatedAreas: [
      "portfolio_view",
      "symbol_summary",
      "ui_summary_paths",
    ],
    followupChecks: [
      "Verify Demo Portfolio service reflects changed data",
      "Check portfolio view path for stale data",
      "Confirm symbol_summary is up-to-date for demo symbols",
    ],
    notes: "Demo Portfolio changes may affect portfolio views and symbol summaries.",
  },
];

/* ─────────────────────────────────────────────
   Normalised empty result
   ───────────────────────────────────────────── */

function emptyHints() {
  return {
    matchedFiles: [],
    relatedFiles: [],
    relatedAreas: [],
    followupChecks: [],
    notes: [],
  };
}

/* ─────────────────────────────────────────────
   Merge helper – deduplicates across mappings
   ───────────────────────────────────────────── */

function mergeHints(accumulated, mapping) {
  for (const f of mapping.relatedFiles || []) {
    if (!accumulated.relatedFiles.includes(f)) {
      accumulated.relatedFiles.push(f);
    }
  }
  for (const a of mapping.relatedAreas || []) {
    if (!accumulated.relatedAreas.includes(a)) {
      accumulated.relatedAreas.push(a);
    }
  }
  for (const c of mapping.followupChecks || []) {
    if (!accumulated.followupChecks.includes(c)) {
      accumulated.followupChecks.push(c);
    }
  }
  if (mapping.notes) {
    const note = typeof mapping.notes === "string" ? mapping.notes : String(mapping.notes);
    if (!accumulated.notes.includes(note)) {
      accumulated.notes.push(note);
    }
  }
}

/* ─────────────────────────────────────────────
   A. getDependencyHintsForFiles(changedFiles)
   ───────────────────────────────────────────── */

/**
 * Given an array of changed file paths / names, return
 * aggregated dependency hints from all matching mappings.
 *
 * @param {string[]} changedFiles
 * @returns {{ matchedFiles: string[], relatedFiles: string[], relatedAreas: string[], followupChecks: string[], notes: string[] }}
 */
function getDependencyHintsForFiles(changedFiles = []) {
  const result = emptyHints();

  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return result;
  }

  const normalised = changedFiles.map((f) => String(f).trim().toLowerCase()).filter(Boolean);

  for (const mapping of DEPENDENCY_MAPPINGS) {
    const matchers = (mapping.matchers || []).map((m) => m.toLowerCase());

    let matched = false;
    for (const file of normalised) {
      for (const matcher of matchers) {
        if (file.includes(matcher) || matcher.includes(file)) {
          matched = true;
          if (!result.matchedFiles.includes(file)) {
            result.matchedFiles.push(file);
          }
          break;
        }
      }
      if (matched) break;
    }

    if (matched) {
      mergeHints(result, mapping);
    }
  }

  return result;
}

/* ─────────────────────────────────────────────
   B. getDependencyHintsForArea(area)
   ───────────────────────────────────────────── */

/**
 * Given an area key (e.g. "snapshot_pipeline", "tech_radar"),
 * return dependency hints for the best matching mapping.
 *
 * @param {string} area
 * @returns {{ matchedFiles: string[], relatedFiles: string[], relatedAreas: string[], followupChecks: string[], notes: string[] }}
 */
function getDependencyHintsForArea(area) {
  const result = emptyHints();

  if (!area || typeof area !== "string") {
    return result;
  }

  const areaLower = area.trim().toLowerCase();

  for (const mapping of DEPENDENCY_MAPPINGS) {
    if (mapping.id === areaLower) {
      result.matchedFiles.push(mapping.id);
      mergeHints(result, mapping);
      return result;
    }
  }

  // Fallback: try partial matcher match
  for (const mapping of DEPENDENCY_MAPPINGS) {
    const matchers = (mapping.matchers || []).map((m) => m.toLowerCase());
    for (const matcher of matchers) {
      if (matcher.includes(areaLower) || areaLower.includes(matcher)) {
        result.matchedFiles.push(mapping.id);
        mergeHints(result, mapping);
        return result;
      }
    }
  }

  return result;
}

/* ─────────────────────────────────────────────
   C. getAllDependencyMappings()
   ───────────────────────────────────────────── */

/**
 * Return the full dependency mapping table for debug /
 * admin inspection purposes.
 *
 * @returns {Array} deep copy of DEPENDENCY_MAPPINGS
 */
function getAllDependencyMappings() {
  return JSON.parse(JSON.stringify(DEPENDENCY_MAPPINGS));
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */

module.exports = {
  getDependencyHintsForFiles,
  getDependencyHintsForArea,
  getAllDependencyMappings,
};
