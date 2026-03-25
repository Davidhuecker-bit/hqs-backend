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
    id            BIGSERIAL PRIMARY KEY,
    title         TEXT NOT NULL,
    summary       TEXT,
    source_url    TEXT,
    source_name   TEXT,
    category      TEXT,           -- 'quant_finance' | 'ai_ml' | 'risk_models' | 'other'
    relevance     TEXT,           -- 'high' | 'medium' | 'low'
    suggestion    TEXT,           -- auto-generated upgrade suggestion for the system
    published_at  TIMESTAMPTZ,
    scanned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_new        BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

        let publishedAt = null;
        if (item.pubDate) {
          const d = new Date(item.pubDate);
          if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
        }

        try {
          await pool.query(
            `INSERT INTO tech_radar_entries
               (title, summary, source_url, source_name, category,
                relevance, suggestion, published_at, scanned_at, is_new)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), true)
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
   EXPORTS
========================================================= */

module.exports = {
  initTechRadarTable,
  scanTechRadar,
  getTechRadarEntries,
  getEvolutionBoard,
  markEntriesSeen,
  TECH_RADAR_FEEDS,
};
