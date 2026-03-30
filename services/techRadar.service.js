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

/**
 * Computes a rule-based HQS relevance assessment for a Tech-Radar entry.
 *
 * @param {{ title: string, summary: string, category: string, source_name: string }} entry
 * @returns {{
 *   fitForHQS: 'yes' | 'maybe' | 'no',
 *   relevanceScore: number,
 *   relevanceLabel: string,
 *   whyItMatters: string,
 *   potentialUseCase: string,
 *   implementationEffort: 'low' | 'medium' | 'high',
 *   riskLevel: 'low' | 'medium' | 'high',
 *   adoptionTiming: 'sofort' | 'kurzfristig' | 'mittelfristig' | 'langfristig' | 'beobachten',
 *   recommendation: string,
 * }}
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
          COUNT(*) FILTER (WHERE scanned_at >= NOW() - INTERVAL '24 hours') AS new_today
        FROM tech_radar_entries
      `),
    ]);

    const s = statsRes.rows[0] || {};
    const stats = {
      total:       Number(s.total        || 0),
      hqsRelevant: Number(s.hqs_relevant || 0),
      unreviewed:  Number(s.unreviewed   || 0),
      watching:    Number(s.watching     || 0),
      rejected:    Number(s.rejected     || 0),
      newToday:    Number(s.new_today    || 0),
    };

    const entries = entriesRes.rows.map((row) => {
      // Enrich with computed HQS assessment if not persisted
      let hqsAssessment = row.hqs_assessment;
      if (!hqsAssessment || typeof hqsAssessment !== "object") {
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
    return { entries: [], stats: { total: 0, hqsRelevant: 0, unreviewed: 0, watching: 0, rejected: 0, newToday: 0 }, generatedAt: new Date().toISOString() };
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
  getAdminTechRadarEntries,
  updateTechRadarEntryStatus,
  VALID_ADMIN_STATUSES,
  TECH_RADAR_FEEDS,
};
