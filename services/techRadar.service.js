"use strict";

/*
  Tech-Radar & Innovation-Scanner Service
  -----------------------------------------
  Scans public RSS feeds (arXiv, quantitative finance, AI research) for new
  mathematical models and AI advances relevant to financial analysis.

  Discovered entries are persisted in `tech_radar_entries` and surfaced in
  the Admin Evolution-Board as self-generated improvement suggestions.

  Table schema
  ------------
  tech_radar_entries (
    id              BIGSERIAL PRIMARY KEY,
    title           TEXT NOT NULL,
    summary         TEXT,
    source_url      TEXT,
    source_name     TEXT,
    category        TEXT,           -- 'quant_finance' | 'ai_ml' | 'risk_models' | 'other'
    relevance       TEXT,           -- 'high' | 'medium' | 'low'
    suggestion      TEXT,           -- auto-generated upgrade suggestion for the system
    published_at    TIMESTAMPTZ,
    scanned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_new          BOOLEAN NOT NULL DEFAULT true,
    status          TEXT DEFAULT 'neu',         -- 'neu' | 'beobachten' | 'prüfen' | 'testen' | 'übernehmen' | 'verworfen'
    rejection_reason TEXT,
    hqs_assessment  JSONB,                      -- computed HQS relevance assessment
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
*/

const axios = require("axios");
const logger = require("../utils/logger");

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
/* =========================================================
   CONSTANTS
========================================================= */

const SCAN_TIMEOUT_MS    = 15_000;
const MAX_ENTRIES_PER_RUN = 30;

// RSS feeds to scan for financial AI/Quant research
const TECH_RADAR_FEEDS = [
  {
    url: "https://export.arxiv.org/rss/q-fin",
    name: "arXiv Quantitative Finance",
    category: "quant_finance",
  },
  {
    url: "https://export.arxiv.org/rss/cs.LG",
    name: "arXiv Machine Learning",
    category: "ai_ml",
  },
  {
    url: "https://export.arxiv.org/rss/q-fin.RM",
    name: "arXiv Risk Management",
    category: "risk_models",
  },
  {
    url: "https://export.arxiv.org/rss/q-fin.CP",
    name: "arXiv Computational Finance",
    category: "quant_finance",
  },
];

// Keywords that boost relevance
const HIGH_RELEVANCE_KEYWORDS = [
  "deep learning", "transformer", "reinforcement learning", "lstm", "neural network",
  "portfolio optimization", "risk model", "factor model", "alpha", "market regime",
  "anomaly detection", "causal inference", "graph neural", "llm", "large language model",
  "quantitative", "algorithmic trading", "time series", "volatility forecasting",
];

const MEDIUM_RELEVANCE_KEYWORDS = [
  "machine learning", "artificial intelligence", "prediction", "classification",
  "regression", "ensemble", "gradient boosting", "random forest", "signal",
  "financial", "stock", "equity", "market", "return", "momentum", "factor",
];

/* =========================================================
   TABLE INIT
========================================================= */

async function initTechRadarTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tech_radar_entries (
      id           BIGSERIAL    PRIMARY KEY,
      title        TEXT         NOT NULL,
      summary      TEXT,
      source_url   TEXT,
      source_name  TEXT,
      category     TEXT         NOT NULL DEFAULT 'other',
      relevance    TEXT         NOT NULL DEFAULT 'low',
      suggestion   TEXT,
      published_at TIMESTAMPTZ,
      scanned_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      is_new       BOOLEAN      NOT NULL DEFAULT true,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tech_radar_scanned_at
    ON tech_radar_entries (scanned_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tech_radar_relevance
    ON tech_radar_entries (relevance, scanned_at DESC);
  `);

  await pool.query(`ALTER TABLE tech_radar_entries ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'neu'`);
  await pool.query(`ALTER TABLE tech_radar_entries ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
  await pool.query(`ALTER TABLE tech_radar_entries ADD COLUMN IF NOT EXISTS hqs_assessment JSONB`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tech_radar_status
    ON tech_radar_entries (status);
  `);

  if (logger?.info) logger.info("tech_radar_entries table ready");
}

/* =========================================================
   RSS FETCH + PARSE
========================================================= */

async function fetchRssFeed(url) {
  const response = await axios.get(url, {
    timeout: SCAN_TIMEOUT_MS,
    responseType: "text",
    headers: {
      "User-Agent": "HQS-TechRadar-Scanner/1.0",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    },
  });
  return String(response?.data || "");
}

function decodeHtmlEntities(text) {
  // Strip HTML tags and CDATA first, then decode entities in a single pass
  const stripped = String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ");

  const ENTITY_MAP = {
    "&amp;": "&", "&quot;": '"', "&#39;": "'",
    "&apos;": "'", "&lt;": "<", "&gt;": ">",
  };
  return stripped
    .replace(/&amp;|&quot;|&#39;|&apos;|&lt;|&gt;/g, (m) => ENTITY_MAP[m] || m)
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(block, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = block.match(regex);
  return m ? decodeHtmlEntities(m[1]) : null;
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title   = extractTag(block, "title")       || "";
    const desc    = extractTag(block, "description") || "";
    const link    = extractTag(block, "link")        || extractTag(block, "guid") || "";
    const pubDate = extractTag(block, "pubDate")     || null;
    if (!title) continue;
    items.push({ title: title.slice(0, 300), summary: desc.slice(0, 1000), link, pubDate });
  }
  return items;
}

/* =========================================================
   RELEVANCE SCORING
========================================================= */

function scoreRelevance(title, summary) {
  const haystack = `${title} ${summary}`.toLowerCase();
  let score = 0;
  for (const kw of HIGH_RELEVANCE_KEYWORDS) {
    if (haystack.includes(kw)) score += 3;
  }
  for (const kw of MEDIUM_RELEVANCE_KEYWORDS) {
    if (haystack.includes(kw)) score += 1;
  }
  if (score >= 6)  return "high";
  if (score >= 2)  return "medium";
  return "low";
}

/* =========================================================
   EVOLUTION SUGGESTION GENERATOR
========================================================= */

const SUGGESTION_TEMPLATES = {
  ai_ml: [
    "Transformer-basierte Zeitreihenanalyse in den MACRO_JUDGE integrieren",
    "LLM-gestütztes Sentiment-Scoring für Nachrichtenanalyse einsetzen",
    "Graph Neural Networks für Sektor-Korrelationen evaluieren",
    "Reinforcement-Learning-Agenten für dynamische Gewichtungsanpassung testen",
    "Attention-Mechanismen zur Signalpriorisierung im AgenticDebate prüfen",
  ],
  quant_finance: [
    "Neuartiges Faktormodell in die Robustness-Matrix integrieren",
    "Verbesserte Volatilitätsprognose-Methode im RISK_SKEPTIC evaluieren",
    "Regime-Detection-Algorithmus mit neuer Markov-Methodik verfeinern",
    "Momentum-Indikatoren auf Basis neuer Forschungsergebnisse kalibrieren",
    "Multi-Faktor-Alpha-Signal in den GROWTH_BIAS einbetten",
  ],
  risk_models: [
    "Erweiterte Tail-Risk-Modellierung für Black-Swan-Szenarien übernehmen",
    "CVaR-basierte Kapitalschutz-Schwellen dynamisch anpassen",
    "Copula-Modell für Sektor-Korrelationen in der Stresstest-Engine einsetzen",
    "Extreme-Value-Theory-Ansatz in die 10-Szenario-Robustness-Matrix integrieren",
    "Liquidity-Adjusted Risk Metrics im Guardian Protocol berücksichtigen",
  ],
  other: [
    "Neue Forschungserkenntnisse in Backtesting-Validierung einbeziehen",
    "Algorithmus-Update für verbesserte Signal-Qualität prüfen",
    "Neue KI-Methode in das Ensemble-Scoring des HQS-Scores evaluieren",
  ],
};

function generateSuggestion(category, title) {
  const templates = SUGGESTION_TEMPLATES[category] || SUGGESTION_TEMPLATES.other;
  // Deterministic pick based on title hash so the same entry always gets the same suggestion
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % templates.length;
  return templates[idx];
}

/* =========================================================
   HQS RELEVANCE ASSESSMENT
========================================================= */

const HQS_AREAS = [
  {
    name: "Datenquellen & Kurse",
    keywords: ["market data", "price feed", "alternative data", "tick data", "order book", "data source", "data feed"],
    useCase: "Erweiterung der Datenquellen für Market-Snapshot-Pipeline",
  },
  {
    name: "News & Signale",
    keywords: ["sentiment", "news", "nlp", "text mining", "event detection", "named entity", "text analysis"],
    useCase: "Verbesserung der News-Signal-Qualität im Entity-Mapper",
  },
  {
    name: "Learning & Memory",
    keywords: ["causal", "memory", "reinforcement", "weight", "adaptive", "online learning", "causal inference"],
    useCase: "Integration in Causal-Memory / dynamische Gewichtungsanpassung",
  },
  {
    name: "Discovery & Scanning",
    keywords: ["opportunity", "screening", "stock selection", "universe", "filter", "scan", "discovery"],
    useCase: "Erweiterung der Discovery-Engine / Opportunity-Scanner",
  },
  {
    name: "Portfolio & Allocation",
    keywords: ["portfolio optimization", "allocation", "position sizing", "diversification", "portfolio"],
    useCase: "Verbesserung der Capital-Allocation / Portfolio-Twin-Logik",
  },
  {
    name: "Risk & Guardian",
    keywords: ["risk", "var", "cvar", "drawdown", "tail risk", "stress test", "hedging", "black swan"],
    useCase: "Integration in Guardian-Protocol / Stresstest-Engine",
  },
  {
    name: "Zeitreihen & Prognose",
    keywords: ["time series", "forecast", "prediction", "volatility", "regime", "momentum"],
    useCase: "Verbesserung der Zeitreihen-Analyse / Regime-Detection",
  },
  {
    name: "KI & Agenten",
    keywords: ["transformer", "llm", "agent", "multi-agent", "ensemble", "neural", "deep learning", "large language model"],
    useCase: "Integration in AgenticDebate / Swarm-Ensemble-Scoring",
  },
  {
    name: "Faktormodelle",
    keywords: ["factor model", "alpha", "smart beta", "multi-factor", "quant", "fundamental", "factor"],
    useCase: "Erweiterung des HQS-Factor-Scoring",
  },
  {
    name: "Infrastruktur",
    keywords: ["scalability", "distributed", "streaming", "real-time", "latency", "pipeline", "performance"],
    useCase: "Optimierung der Backend-Infrastruktur / Pipeline-Performance",
  },
  {
    name: "Frontend & UX",
    keywords: ["visualization", "dashboard", "explainability", "interpretability"],
    useCase: "Verbesserung der Admin-Dashboard-Darstellung",
  },
];

const NEGATIVE_KEYWORDS = ["blockchain", "cryptocurrency", "nft", "gaming", "social media", "web3", "metaverse"];

/* =========================================================
   STRATEGIC ASSESSMENT – HQS-Strategiebewertung (v2)
   ---------------------------------------------------------
   Rule-based strategic scoring aligned to real HQS system
   areas, Node.js/Railway stack, and current project roadmap.
========================================================= */

/**
 * Extended system areas for strategic HQS assessment.
 * Each area maps to a short ID used in the `systemArea` output array.
 */
const HQS_STRATEGIC_AREAS = [
  {
    id: "data",
    name: "Datenquellen / Datenerfassung",
    keywords: ["market data", "price feed", "alternative data", "tick data", "order book",
               "data source", "data feed", "data pipeline", "data ingestion", "api integration",
               "websocket", "real-time data"],
    whyNow: "Datenqualität ist Grundlage aller HQS-Entscheidungen",
    deps: [],
  },
  {
    id: "historical",
    name: "Historische Daten / Backfills",
    keywords: ["historical data", "backfill", "flatfile", "csv", "time series database",
               "data warehouse", "archival", "batch processing", "historical analysis",
               "data history", "long-term data"],
    whyNow: "Historische Tiefe stärkt Backtest- und Maturity-Qualität",
    deps: ["Stabile Datenquellen-Anbindung"],
  },
  {
    id: "news",
    name: "News / Entity-Verarbeitung",
    keywords: ["sentiment", "news", "nlp", "text mining", "event detection",
               "named entity", "entity recognition", "information extraction",
               "news analysis", "text classification"],
    whyNow: "News-Signale liefern Echtzeit-Kontext für Investmententscheidungen",
    deps: [],
  },
  {
    id: "signals",
    name: "Signalverarbeitung / Zeitreihen",
    keywords: ["signal processing", "time series", "forecast", "prediction",
               "volatility", "regime", "momentum", "indicator", "anomaly detection",
               "pattern recognition", "trend detection"],
    whyNow: "Signalqualität bestimmt direkt die Scoring-Güte",
    deps: ["Stabile Datenquellen"],
  },
  {
    id: "discovery",
    name: "Discovery / Radar / Frühsignale",
    keywords: ["opportunity", "screening", "stock selection", "universe", "filter",
               "scan", "discovery", "early signal", "market scan", "stock screener"],
    whyNow: "Discovery-Engine ist aktiver HQS-Wachstumspfad",
    deps: ["Funktionierendes Scoring"],
  },
  {
    id: "learning",
    name: "Learning / Outcome / Feedback",
    keywords: ["causal", "memory", "reinforcement", "adaptive", "online learning",
               "causal inference", "outcome", "feedback", "regime detection",
               "meta-learning", "transfer learning", "continual learning"],
    whyNow: "Outcome-Tracking & Feedback-Loops sind nächste HQS-Reifestufe",
    deps: ["Stabile Outcome-Tracking-Basis", "Ausreichend historische Daten"],
  },
  {
    id: "portfolio",
    name: "Portfolio-Intelligenz",
    keywords: ["portfolio optimization", "allocation", "position sizing",
               "diversification", "portfolio", "rebalancing", "capital allocation",
               "portfolio construction", "asset allocation"],
    whyNow: "Portfolio-Logik ist Kernstück der HQS-Wertschöpfung",
    deps: ["Stabiles Scoring", "Guardian-Grundschutz"],
  },
  {
    id: "guardian",
    name: "Guardian / Risk / Explainability",
    keywords: ["risk", "var", "cvar", "drawdown", "tail risk", "stress test",
               "hedging", "black swan", "explainability", "interpretability",
               "risk management", "risk monitoring", "risk assessment"],
    whyNow: "Kapitalschutz hat höchste operative Priorität",
    deps: [],
  },
  {
    id: "frontend",
    name: "Frontend / Companion / Meaning-First",
    keywords: ["visualization", "dashboard", "ui", "ux", "user interface",
               "frontend", "companion", "human-in-the-loop", "user experience",
               "interactive", "chart", "visual analytics"],
    whyNow: "Frontend-Verständlichkeit bestimmt Nutzbarkeit des Systems",
    deps: ["Backend-Datenqualität"],
  },
  {
    id: "infra",
    name: "Infra / Railway / Performance",
    keywords: ["scalability", "distributed", "streaming", "real-time", "latency",
               "pipeline", "performance", "infrastructure", "deployment",
               "containerization", "database", "postgres", "caching", "redis",
               "monitoring", "logging", "observability"],
    whyNow: "Systemstabilität ist Voraussetzung für alle Erweiterungen",
    deps: [],
  },
  {
    id: "governance",
    name: "Governance / Policy / Audit",
    keywords: ["governance", "policy", "compliance", "audit", "autonomy",
               "regulation", "oversight", "transparency", "accountability",
               "data privacy", "gdpr", "access control"],
    whyNow: "Governance wird mit steigender Autonomie zunehmend kritisch",
    deps: ["Stabile Grundinfrastruktur", "Klare Autonomie-Stufen"],
  },
  {
    id: "automation",
    name: "Automation / Agenten",
    keywords: ["agent", "multi-agent", "automation", "orchestration", "workflow",
               "autonomous", "bot", "task automation", "scheduled job"],
    whyNow: "Automatisierung reduziert operative Last und erhöht Konsistenz",
    deps: ["Stabiles Guardian-Protocol", "Governance-Rahmen"],
  },
  {
    id: "research",
    name: "Research / Future Lab",
    keywords: ["transformer", "llm", "large language model", "ensemble",
               "neural", "deep learning", "novel", "emerging", "cutting-edge",
               "state-of-the-art", "breakthrough"],
    whyNow: "Research-Monitoring sichert langfristige Wettbewerbsfähigkeit",
    deps: ["Stabile operative Basis"],
  },
];

// Stack-Fit detection keywords
const STACK_FIT_POSITIVE = [
  "javascript", "node", "nodejs", "typescript", "npm", "express",
  "postgres", "postgresql", "sql", "rest", "json", "websocket",
  "http", "lightweight", "microservice", "docker", "railway",
];
const STACK_FIT_MIXED = [
  "python", "tensorflow", "pytorch", "scikit", "pandas", "numpy",
  "jupyter", "r language", "flask", "fastapi", "django",
];
const STACK_FIT_NEGATIVE = [
  "java", "spring", "c++", "rust lang", "golang", "go lang",
  "kubernetes cluster", "spark", "hadoop", "scala", "jvm",
  ".net", "c#", "gpu cluster", "fpga", "hpc",
  "high performance computing", "cuda",
];

// Hype / Moonshot detection
const HYPE_KEYWORDS = [
  "blockchain", "cryptocurrency", "nft", "gaming", "social media",
  "web3", "metaverse", "crypto", "defi", "dao", "token",
  "play-to-earn", "meme",
];
const MOONSHOT_KEYWORDS = [
  "quantum computing", "quantum machine learning", "agi",
  "artificial general intelligence", "brain-computer",
  "neuromorphic", "dna computing", "quantum supremacy",
];

// Areas where HQS already has strong coverage → higher duplication risk
const ESTABLISHED_AREAS = ["data", "signals", "portfolio", "guardian", "frontend"];
// Areas that are growth/expansion targets → lower duplication risk
const GROWTH_AREAS = ["governance", "automation", "research", "learning", "historical"];

/**
 * Computes a strategic HQS assessment for a Tech-Radar entry.
 * Rule-based, deterministic, no LLM dependency.
 *
 * @param {{ title: string, summary: string, category: string, source_name?: string }} entry
 * @returns {{
 *   strategicFit: 'high' | 'medium' | 'low',
 *   systemArea: string[],
 *   impactScore: number,
 *   effortScore: number,
 *   riskScore: number,
 *   priorityScore: number,
 *   timeHorizon: 'now' | 'mid' | 'later',
 *   decisionHint: 'watch' | 'evaluate' | 'test' | 'adopt' | 'reject',
 *   whyNow: string,
 *   dependencies: string[],
 *   stackFit: 'good' | 'mixed' | 'weak',
 *   duplicationRisk: 'low' | 'medium' | 'high',
 * }}
 */
function computeStrategicTechAssessment(entry) {
  const haystack = `${entry.title || ""} ${entry.summary || ""}`.toLowerCase();

  /* ── 1. Matched system areas ─────────────────────────── */
  const matchedAreas = [];
  let totalAreaKeywordHits = 0;

  for (const area of HQS_STRATEGIC_AREAS) {
    let hits = 0;
    for (const kw of area.keywords) {
      if (haystack.includes(kw)) hits++;
    }
    if (hits > 0) {
      matchedAreas.push(area);
      totalAreaKeywordHits += hits;
    }
  }
  const systemArea = matchedAreas.map((a) => a.id);

  /* ── 2. Stack-Fit ────────────────────────────────────── */
  let stackPositiveHits = 0;
  let stackMixedHits = 0;
  let stackNegativeHits = 0;

  for (const kw of STACK_FIT_POSITIVE)  { if (haystack.includes(kw)) stackPositiveHits++; }
  for (const kw of STACK_FIT_MIXED)     { if (haystack.includes(kw)) stackMixedHits++; }
  for (const kw of STACK_FIT_NEGATIVE)  { if (haystack.includes(kw)) stackNegativeHits++; }

  let stackFit;
  if (stackNegativeHits >= 2 || (stackNegativeHits >= 1 && stackPositiveHits === 0)) {
    stackFit = "weak";
  } else if (stackPositiveHits > 0) {
    stackFit = "good";
  } else if (stackMixedHits > 0) {
    stackFit = "mixed";
  } else {
    // No stack mentioned – default by category (research papers are usually stack-agnostic)
    stackFit = entry.category === "ai_ml" ? "mixed" : "good";
  }

  /* ── 3. Hype / Moonshot detection ────────────────────── */
  let hypeHits = 0;
  let moonshotHits = 0;
  for (const kw of HYPE_KEYWORDS)     { if (haystack.includes(kw)) hypeHits++; }
  for (const kw of MOONSHOT_KEYWORDS) { if (haystack.includes(kw)) moonshotHits++; }

  const isHype     = hypeHits >= 2 || (hypeHits >= 1 && matchedAreas.length === 0);
  const isMoonshot = moonshotHits >= 1;

  /* ── 4. strategicFit ─────────────────────────────────── */
  let strategicFit;
  if (isHype) {
    strategicFit = "low";
  } else if (matchedAreas.length >= 2 && totalAreaKeywordHits >= 3) {
    strategicFit = "high";
  } else if (matchedAreas.length >= 1) {
    strategicFit = "medium";
  } else {
    strategicFit = "low";
  }

  /* ── 5. impactScore (0-100) ──────────────────────────── */
  let impactScore = 0;
  impactScore += matchedAreas.length * 15;    // up to ~60 for 4 areas
  impactScore += totalAreaKeywordHits * 3;    // depth bonus
  if (entry.category === "quant_finance") impactScore += 10;
  else if (entry.category === "risk_models") impactScore += 8;
  else if (entry.category === "ai_ml") impactScore += 5;
  if (isHype) impactScore = Math.max(5, impactScore - 40);
  if (isMoonshot) impactScore = Math.max(10, impactScore - 20);
  impactScore = Math.min(100, Math.max(0, impactScore));

  /* ── 6. effortScore (0-100) – higher = more effort ───── */
  let effortScore = 30;
  if (entry.category === "ai_ml") effortScore += 25;
  else if (entry.category === "risk_models") effortScore += 20;
  else if (entry.category === "quant_finance") effortScore += 10;
  if (stackFit === "weak") effortScore += 25;
  else if (stackFit === "mixed") effortScore += 10;
  if (isMoonshot) effortScore += 20;
  if (matchedAreas.some((a) => a.id === "research")) effortScore += 10;
  if (matchedAreas.some((a) => a.id === "learning")) effortScore += 10;
  effortScore = Math.min(100, Math.max(0, effortScore));

  /* ── 7. riskScore (0-100) – higher = more risk ──────── */
  let riskScore = 20;
  if (entry.category === "risk_models") riskScore += 15;
  else if (entry.category === "ai_ml") riskScore += 10;
  if (stackFit === "weak") riskScore += 25;
  else if (stackFit === "mixed") riskScore += 10;
  if (isHype) riskScore += 20;
  if (isMoonshot) riskScore += 15;
  if (matchedAreas.some((a) => a.id === "infra")) riskScore += 10;
  riskScore = Math.min(100, Math.max(0, riskScore));

  /* ── 8. priorityScore (0-100) – composite ───────────── */
  let priorityScore = Math.round(
    impactScore * 0.45 - effortScore * 0.25 - riskScore * 0.15 + 30
  );
  if (strategicFit === "high") priorityScore += 15;
  else if (strategicFit === "medium") priorityScore += 5;
  if (stackFit === "good") priorityScore += 5;
  else if (stackFit === "weak") priorityScore -= 10;
  priorityScore = Math.min(100, Math.max(0, priorityScore));

  /* ── 9. duplicationRisk ──────────────────────────────── */
  const establishedHits = matchedAreas.filter((a) => ESTABLISHED_AREAS.includes(a.id)).length;
  const growthHits = matchedAreas.filter((a) => GROWTH_AREAS.includes(a.id)).length;
  let duplicationRisk;
  if (establishedHits >= 2) duplicationRisk = "high";
  else if (establishedHits >= 1 && growthHits === 0) duplicationRisk = "medium";
  else duplicationRisk = "low";

  /* ── 10. timeHorizon ─────────────────────────────────── */
  let timeHorizon;
  if (isMoonshot) {
    timeHorizon = "later";
  } else if (strategicFit === "high" && effortScore <= 50 && stackFit !== "weak") {
    timeHorizon = "now";
  } else if (strategicFit === "high" && effortScore <= 70) {
    timeHorizon = "mid";
  } else if (strategicFit === "medium" && effortScore <= 60) {
    timeHorizon = "mid";
  } else {
    timeHorizon = "later";
  }

  /* ── 11. decisionHint ────────────────────────────────── */
  let decisionHint;
  if (isHype && strategicFit === "low") {
    decisionHint = "reject";
  } else if (stackFit === "weak" && impactScore < 40) {
    decisionHint = "reject";
  } else if (impactScore >= 60 && effortScore <= 45 && stackFit === "good" && !isMoonshot) {
    decisionHint = "adopt";
  } else if (impactScore >= 50 && effortScore <= 55 && stackFit !== "weak" && !isMoonshot) {
    decisionHint = "test";
  } else if (impactScore >= 35 && strategicFit !== "low") {
    decisionHint = "evaluate";
  } else if (matchedAreas.length > 0 || impactScore >= 15) {
    decisionHint = "watch";
  } else {
    decisionHint = "reject";
  }

  /* ── 12. whyNow ──────────────────────────────────────── */
  let whyNow;
  if (isHype) {
    whyNow = "Tech-Hype ohne konkreten HQS-Nutzen – aktuell nicht relevant.";
  } else if (isMoonshot) {
    whyNow = "Moonshot-Thema – interessant für langfristige Beobachtung, operativ noch nicht einsetzbar.";
  } else if (matchedAreas.length > 0) {
    const topArea = matchedAreas[0];
    if (timeHorizon === "now") {
      whyNow = `Passt direkt in den aktiven HQS-Bereich „${topArea.name}" – ${topArea.whyNow}.`;
    } else if (timeHorizon === "mid") {
      whyNow = `Relevant für „${topArea.name}" – mittelfristig einsetzbar, wenn Voraussetzungen erfüllt.`;
    } else {
      whyNow = `Betrifft „${topArea.name}" – derzeit eher Zukunftsthema, Grundlagen fehlen noch.`;
    }
  } else {
    whyNow = "Kein klarer HQS-Bezug identifiziert – eher generische Forschung.";
  }

  /* ── 13. dependencies ────────────────────────────────── */
  const depSet = new Set();
  for (const area of matchedAreas) {
    for (const dep of area.deps) depSet.add(dep);
  }
  if (stackFit === "mixed") depSet.add("Saubere Python-Job-Separation");
  if (stackFit === "weak") depSet.add("Grundlegender Stack-Umbau erforderlich");
  const dependencies = Array.from(depSet);

  return {
    strategicFit,
    systemArea,
    impactScore,
    effortScore,
    riskScore,
    priorityScore,
    timeHorizon,
    decisionHint,
    whyNow,
    dependencies,
    stackFit,
    duplicationRisk,
  };
}

/**
 * Computes a rule-based HQS relevance assessment for a Tech-Radar entry.
 * Now includes the extended strategic assessment fields.
 *
 * @param {{ title: string, summary: string, category: string, source_name: string }} entry
 * @returns {object} Full HQS assessment including strategic fields.
 */
function computeHqsRelevanceEntry(entry) {
  const haystack = `${entry.title || ""} ${entry.summary || ""}`.toLowerCase();

  let score = 0;
  let topArea = null;
  let topAreaMatches = 0;

  // HQS area keyword matching (+5 per area hit)
  for (const area of HQS_AREAS) {
    let areaMatches = 0;
    for (const kw of area.keywords) {
      if (haystack.includes(kw)) areaMatches++;
    }
    if (areaMatches > 0) {
      score += 5;
      if (areaMatches > topAreaMatches) {
        topAreaMatches = areaMatches;
        topArea = area;
      }
    }
  }

  // HIGH_RELEVANCE_KEYWORDS add +8 each
  for (const kw of HIGH_RELEVANCE_KEYWORDS) {
    if (haystack.includes(kw)) score += 8;
  }

  // MEDIUM_RELEVANCE_KEYWORDS add +3 each
  for (const kw of MEDIUM_RELEVANCE_KEYWORDS) {
    if (haystack.includes(kw)) score += 3;
  }

  score = Math.min(100, score);

  // Negative filter: if negative keywords present and no area matched
  const hasNegative = NEGATIVE_KEYWORDS.some((kw) => haystack.includes(kw));
  if (hasNegative && !topArea) {
    score = Math.min(5, score);
  }

  // fitForHQS
  let fitForHQS;
  if (score >= 50) fitForHQS = "yes";
  else if (score >= 20) fitForHQS = "maybe";
  else fitForHQS = "no";

  // relevanceLabel
  let relevanceLabel;
  if (score >= 50) relevanceLabel = "Hohe Relevanz";
  else if (score >= 20) relevanceLabel = "Mittlere Relevanz";
  else if (score >= 5) relevanceLabel = "Niedrige Relevanz";
  else relevanceLabel = "Nicht relevant";

  // adoptionTiming
  let adoptionTiming;
  if (score >= 70) adoptionTiming = "sofort";
  else if (score >= 50) adoptionTiming = "kurzfristig";
  else if (score >= 30) adoptionTiming = "mittelfristig";
  else if (score >= 15) adoptionTiming = "langfristig";
  else adoptionTiming = "beobachten";

  // implementationEffort based on category
  let implementationEffort;
  if (["ai_ml", "risk_models"].includes(entry.category)) implementationEffort = "high";
  else if (entry.category === "quant_finance") implementationEffort = "medium";
  else implementationEffort = "low";

  // riskLevel based on category
  let riskLevel;
  if (entry.category === "risk_models") riskLevel = "high";
  else if (["ai_ml", "quant_finance"].includes(entry.category)) riskLevel = "medium";
  else riskLevel = "low";

  // potentialUseCase and whyItMatters from topArea
  const potentialUseCase = topArea
    ? topArea.useCase
    : "Allgemeine Systemverbesserung / weitere Evaluation erforderlich";

  const whyItMatters = topArea
    ? `Relevant für HQS im Bereich „${topArea.name}": Dieses Thema adressiert Kernaspekte der HQS-Systemarchitektur.`
    : "Kein direkter HQS-Bereich identifiziert – weitere manuelle Prüfung empfohlen.";

  // recommendation
  let recommendation;
  if (fitForHQS === "yes" && adoptionTiming === "sofort") {
    recommendation = "Sofort evaluieren und Proof-of-Concept im HQS-System anstoßen.";
  } else if (fitForHQS === "yes" && adoptionTiming === "kurzfristig") {
    recommendation = "Kurzfristig prüfen und in die nächste Entwicklungsiteration einplanen.";
  } else if (fitForHQS === "yes") {
    recommendation = "Mittelfristig beobachten und bei passendem Entwicklungskontext aufgreifen.";
  } else if (fitForHQS === "maybe") {
    recommendation = "Im Blick behalten – bei konkretem Use-Case erneut bewerten.";
  } else {
    recommendation = "Kein klarer HQS-Fit – vorerst nicht weiter verfolgen.";
  }

  // Compute strategic assessment and merge
  const strategic = computeStrategicTechAssessment(entry);

  return {
    fitForHQS,
    relevanceScore: score,
    relevanceLabel,
    whyItMatters,
    potentialUseCase,
    implementationEffort,
    riskLevel,
    adoptionTiming,
    recommendation,
    ...strategic,
  };
}

/* =========================================================
   DEDUPLICATION
========================================================= */

async function getExistingUrls() {
  try {
    const res = await pool.query(
      `SELECT source_url FROM tech_radar_entries
       WHERE scanned_at >= NOW() - INTERVAL '7 days'`
    );
    return new Set(res.rows.map((r) => r.source_url).filter(Boolean));
  } catch {
    return new Set();
  }
}

/* =========================================================
   MAIN SCAN FUNCTION
========================================================= */

/**
 * Runs the Tech-Radar scan against all configured RSS feeds.
 * New entries are persisted; existing ones (by URL) are skipped.
 *
 * @returns {Promise<{ scanned: number, inserted: number, feeds: number }>}
 */
async function scanTechRadar() {
  let totalScanned = 0;
  let totalInserted = 0;
  let feedsOk = 0;

  const existingUrls = await getExistingUrls();

  for (const feed of TECH_RADAR_FEEDS) {
    try {
      const xml = await fetchRssFeed(feed.url);
      const items = parseRssItems(xml).slice(0, MAX_ENTRIES_PER_RUN);
      totalScanned += items.length;

      for (const item of items) {
        const url = item.link;
        if (url && existingUrls.has(url)) continue;

        const relevance  = scoreRelevance(item.title, item.summary);
        const suggestion = generateSuggestion(feed.category, item.title);
        const hqsAssessment = computeHqsRelevanceEntry({
          title: item.title,
          summary: item.summary || "",
          category: feed.category,
          source_name: feed.name,
        });

        let publishedAt = null;
        if (item.pubDate) {
          const d = new Date(item.pubDate);
          if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
        }

        try {
          await pool.query(
            `INSERT INTO tech_radar_entries
               (title, summary, source_url, source_name, category,
                relevance, suggestion, published_at, scanned_at, is_new, hqs_assessment)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), true, $9)
             ON CONFLICT DO NOTHING`,
            [
              item.title,
              item.summary || null,
              url || null,
              feed.name,
              feed.category,
              relevance,
              suggestion,
              publishedAt,
              JSON.stringify(hqsAssessment),
            ]
          );
          totalInserted++;
          if (url) existingUrls.add(url);
        } catch (insertErr) {
          logger.warn("techRadar: insert failed", { message: insertErr.message });
        }
      }

      feedsOk++;
    } catch (err) {
      logger.warn("techRadar: feed fetch failed", {
        url: feed.url,
        message: err.message,
      });
    }
  }

  logger.info("techRadar.scanTechRadar completed", {
    feedsOk,
    totalScanned,
    totalInserted,
  });

  return { scanned: totalScanned, inserted: totalInserted, feeds: feedsOk };
}

/* =========================================================
   READ FUNCTIONS
========================================================= */

/**
 * Returns Tech-Radar entries filtered by relevance/category.
 *
 * @param {{ limit?: number, relevance?: string, category?: string }} options
 */
async function getTechRadarEntries({ limit = 50, relevance = null, category = null } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const conditions = [];
  const params = [];

  if (relevance && ["high", "medium", "low"].includes(relevance)) {
    conditions.push(`relevance = $${params.length + 1}`);
    params.push(relevance);
  }
  if (category) {
    conditions.push(`category = $${params.length + 1}`);
    params.push(category);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(safeLimit);

  try {
    const res = await pool.query(
      `SELECT id, title, summary, source_url, source_name, category,
              relevance, suggestion, published_at, scanned_at, is_new
       FROM tech_radar_entries
       ${where}
       ORDER BY
         CASE relevance WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         scanned_at DESC
       LIMIT $${params.length}`,
      params
    );
    return res.rows;
  } catch (err) {
    logger.warn("techRadar.getTechRadarEntries: DB error", { message: err.message });
    return [];
  }
}

/**
 * Returns aggregated Evolution-Board data: high-relevance entries grouped as
 * improvement suggestions for the system.
 *
 * @returns {Promise<{
 *   suggestions: Array<{ category, suggestion, sourceTitle, sourceUrl, relevance, scannedAt }>,
 *   stats: { total, high, medium, low, newToday },
 *   generatedAt: string
 * }>}
 */
async function getEvolutionBoard() {
  try {
    const [entriesRes, statsRes] = await Promise.all([
      pool.query(`
        SELECT id, title, source_url, source_name, category, relevance, suggestion, scanned_at
        FROM tech_radar_entries
        WHERE relevance IN ('high', 'medium')
        ORDER BY
          CASE relevance WHEN 'high' THEN 1 ELSE 2 END,
          scanned_at DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT
          COUNT(*)                                               AS total,
          COUNT(*) FILTER (WHERE relevance = 'high')           AS high,
          COUNT(*) FILTER (WHERE relevance = 'medium')         AS medium,
          COUNT(*) FILTER (WHERE relevance = 'low')            AS low,
          COUNT(*) FILTER (WHERE scanned_at >= NOW() - INTERVAL '24 hours') AS new_today
        FROM tech_radar_entries
      `),
    ]);

    const suggestions = entriesRes.rows.map((r) => ({
      id: r.id,
      category: r.category,
      suggestion: r.suggestion,
      sourceTitle: r.title,
      sourceUrl: r.source_url,
      sourceName: r.source_name,
      relevance: r.relevance,
      scannedAt: r.scanned_at,
    }));

    const s = statsRes.rows[0] || {};
    return {
      suggestions,
      stats: {
        total:    Number(s.total    || 0),
        high:     Number(s.high     || 0),
        medium:   Number(s.medium   || 0),
        low:      Number(s.low      || 0),
        newToday: Number(s.new_today || 0),
      },
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn("techRadar.getEvolutionBoard: DB error", { message: err.message });
    return {
      suggestions: [],
      stats: { total: 0, high: 0, medium: 0, low: 0, newToday: 0 },
      generatedAt: new Date().toISOString(),
    };
  }
}

/* =========================================================
   MARK AS SEEN
========================================================= */

async function markEntriesSeen() {
  try {
    await pool.query(
      `UPDATE tech_radar_entries SET is_new = false WHERE is_new = true`
    );
  } catch (err) {
    logger.warn("techRadar.markEntriesSeen: DB error", { message: err.message });
  }
}

/* =========================================================
   ADMIN READ / STATUS FUNCTIONS
========================================================= */

/**
 * Returns Tech-Radar entries with extended filters for the admin interface.
 *
 * @param {{
 *   limit?: number,
 *   category?: string,
 *   status?: string,
 *   fitForHQS?: string,
 *   hasLink?: boolean,
 *   isNew?: boolean,
 *   unreviewed?: boolean,
 *   adoptionTiming?: string,
 *   relevance?: string,
 *   strategicFit?: string,
 *   timeHorizon?: string,
 *   decisionHint?: string,
 *   stackFit?: string,
 * }} filter
 * @returns {Promise<{ entries: Array, stats: object, generatedAt: string }>}
 */
async function getAdminTechRadarEntries(filter = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(filter.limit) || 50));
  const conditions = [];
  const params = [];

  if (filter.category) {
    conditions.push(`category = $${params.length + 1}`);
    params.push(filter.category);
  }
  if (filter.relevance && ["high", "medium", "low"].includes(filter.relevance)) {
    conditions.push(`relevance = $${params.length + 1}`);
    params.push(filter.relevance);
  }
  if (filter.status) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(filter.status);
  }
  if (filter.fitForHQS && ["yes", "maybe", "no"].includes(filter.fitForHQS)) {
    conditions.push(`hqs_assessment->>'fitForHQS' = $${params.length + 1}`);
    params.push(filter.fitForHQS);
  }
  if (filter.adoptionTiming) {
    conditions.push(`hqs_assessment->>'adoptionTiming' = $${params.length + 1}`);
    params.push(filter.adoptionTiming);
  }
  if (filter.strategicFit && ["high", "medium", "low"].includes(filter.strategicFit)) {
    conditions.push(`hqs_assessment->>'strategicFit' = $${params.length + 1}`);
    params.push(filter.strategicFit);
  }
  if (filter.timeHorizon && ["now", "mid", "later"].includes(filter.timeHorizon)) {
    conditions.push(`hqs_assessment->>'timeHorizon' = $${params.length + 1}`);
    params.push(filter.timeHorizon);
  }
  if (filter.decisionHint && ["watch", "evaluate", "test", "adopt", "reject"].includes(filter.decisionHint)) {
    conditions.push(`hqs_assessment->>'decisionHint' = $${params.length + 1}`);
    params.push(filter.decisionHint);
  }
  if (filter.stackFit && ["good", "mixed", "weak"].includes(filter.stackFit)) {
    conditions.push(`hqs_assessment->>'stackFit' = $${params.length + 1}`);
    params.push(filter.stackFit);
  }
  if (filter.hasLink === true) {
    conditions.push(`source_url IS NOT NULL AND source_url != ''`);
  } else if (filter.hasLink === false) {
    conditions.push(`(source_url IS NULL OR source_url = '')`);
  }
  if (filter.isNew === true) {
    conditions.push(`is_new = true`);
  }
  if (filter.unreviewed === true) {
    conditions.push(`(status = 'neu' OR status IS NULL)`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(safeLimit);

  try {
    const [entriesRes, statsRes] = await Promise.all([
      pool.query(
        `SELECT id, title, summary, source_url, source_name, category,
                relevance, suggestion, published_at, scanned_at, is_new,
                status, rejection_reason, hqs_assessment
         FROM tech_radar_entries
         ${where}
         ORDER BY
           CASE relevance WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           scanned_at DESC
         LIMIT $${params.length}`,
        params
      ),
      pool.query(`
        SELECT
          COUNT(*)                                                           AS total,
          COUNT(*) FILTER (WHERE hqs_assessment->>'fitForHQS' = 'yes')     AS hqs_relevant,
          COUNT(*) FILTER (WHERE status = 'neu' OR status IS NULL)          AS unreviewed,
          COUNT(*) FILTER (WHERE status = 'beobachten')                     AS watching,
          COUNT(*) FILTER (WHERE status = 'verworfen')                      AS rejected,
          COUNT(*) FILTER (WHERE scanned_at >= NOW() - INTERVAL '24 hours') AS new_today,
          COUNT(*) FILTER (WHERE hqs_assessment->>'strategicFit' = 'high') AS strategic_high,
          COUNT(*) FILTER (WHERE hqs_assessment->>'decisionHint' IN ('test', 'adopt')) AS actionable
        FROM tech_radar_entries
      `),
    ]);

    const s = statsRes.rows[0] || {};
    const stats = {
      total:         Number(s.total          || 0),
      hqsRelevant:   Number(s.hqs_relevant   || 0),
      unreviewed:    Number(s.unreviewed     || 0),
      watching:      Number(s.watching       || 0),
      rejected:      Number(s.rejected       || 0),
      newToday:      Number(s.new_today      || 0),
      strategicHigh: Number(s.strategic_high || 0),
      actionable:    Number(s.actionable     || 0),
    };

    const entries = entriesRes.rows.map((row) => {
      // Enrich with computed HQS assessment if not persisted or missing strategic fields
      let hqsAssessment = row.hqs_assessment;
      if (
        !hqsAssessment ||
        typeof hqsAssessment !== "object" ||
        !hqsAssessment.strategicFit
      ) {
        hqsAssessment = computeHqsRelevanceEntry({
          title: row.title,
          summary: row.summary || "",
          category: row.category,
          source_name: row.source_name,
        });
      }
      return {
        ...row,
        hqs_assessment: hqsAssessment,
        status: row.status || "neu",
      };
    });

    return { entries, stats, generatedAt: new Date().toISOString() };
  } catch (err) {
    logger.warn("techRadar.getAdminTechRadarEntries: DB error", { message: err.message });
    return {
      entries: [],
      stats: { total: 0, hqsRelevant: 0, unreviewed: 0, watching: 0, rejected: 0, newToday: 0, strategicHigh: 0, actionable: 0 },
      generatedAt: new Date().toISOString(),
    };
  }
}

const VALID_ADMIN_STATUSES = ["beobachten", "prüfen", "testen", "übernehmen", "verworfen"];

/**
 * Updates the status (and optionally rejection_reason) of a Tech-Radar entry.
 *
 * @param {number} id
 * @param {string} status
 * @param {string|null} rejectionReason
 * @returns {Promise<object>} the updated row
 */
async function updateTechRadarEntryStatus(id, status, rejectionReason) {
  if (!VALID_ADMIN_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${VALID_ADMIN_STATUSES.join(", ")}`);
  }
  const reason = status === "verworfen" ? (rejectionReason || null) : null;

  try {
    const res = await pool.query(
      `UPDATE tech_radar_entries
       SET status = $1, rejection_reason = $2
       WHERE id = $3
       RETURNING id, title, status, rejection_reason, hqs_assessment, scanned_at`,
      [status, reason, id]
    );
    if (res.rowCount === 0) {
      throw new Error(`Tech-Radar entry with id ${id} not found`);
    }
    return res.rows[0];
  } catch (err) {
    if (err.message.includes("not found")) throw err;
    logger.warn("techRadar.updateTechRadarEntryStatus: DB error", { message: err.message });
    throw err;
  }
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  initTechRadarTable,
  scanTechRadar,
  getTechRadarEntries,
  getEvolutionBoard,
  markEntriesSeen,
  computeHqsRelevanceEntry,
  computeStrategicTechAssessment,
  getAdminTechRadarEntries,
  updateTechRadarEntryStatus,
  VALID_ADMIN_STATUSES,
  TECH_RADAR_FEEDS,
};
