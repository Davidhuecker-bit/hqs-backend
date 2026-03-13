"use strict";

const { Pool } = require("pg");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value, maxLength = 500) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function normalizeStringArray(values, maxItems = 50, maxItemLength = 120) {
  if (!Array.isArray(values)) return [];
  const cleaned = values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => value.slice(0, maxItemLength));

  return [...new Set(cleaned)].slice(0, maxItems);
}

async function initEntityMapTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entity_map (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      company_name TEXT,
      sector TEXT,
      industry TEXT,
      themes JSONB DEFAULT '[]'::jsonb,
      commodities JSONB DEFAULT '[]'::jsonb,
      countries JSONB DEFAULT '[]'::jsonb,
      aliases JSONB DEFAULT '[]'::jsonb,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_entity_map_symbol
    ON entity_map(symbol);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_entity_map_sector
    ON entity_map(sector);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_entity_map_industry
    ON entity_map(industry);
  `);

  if (logger?.info) logger.info("entity_map table ready");
}

async function upsertEntityMapEntries(entries = []) {
  if (!Array.isArray(entries) || !entries.length) {
    return { insertedOrUpdated: 0 };
  }

  let insertedOrUpdated = 0;

  for (const entry of entries) {
    const symbol = normalizeSymbol(entry?.symbol);
    if (!symbol) continue;

    const companyName = normalizeText(entry?.company_name || entry?.companyName, 255);
    const sector = normalizeText(entry?.sector, 120);
    const industry = normalizeText(entry?.industry, 120);
    const themes = normalizeStringArray(entry?.themes, 50, 120);
    const commodities = normalizeStringArray(entry?.commodities, 50, 120);
    const countries = normalizeStringArray(entry?.countries, 50, 120);
    const aliases = normalizeStringArray(entry?.aliases, 100, 120);
    const isActive =
      typeof entry?.is_active === "boolean"
        ? entry.is_active
        : typeof entry?.isActive === "boolean"
          ? entry.isActive
          : true;

    await pool.query(
      `
      INSERT INTO entity_map (
        symbol,
        company_name,
        sector,
        industry,
        themes,
        commodities,
        countries,
        aliases,
        is_active,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,NOW(),NOW())
      ON CONFLICT (symbol)
      DO UPDATE SET
        company_name = EXCLUDED.company_name,
        sector = EXCLUDED.sector,
        industry = EXCLUDED.industry,
        themes = EXCLUDED.themes,
        commodities = EXCLUDED.commodities,
        countries = EXCLUDED.countries,
        aliases = EXCLUDED.aliases,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
      `,
      [
        symbol,
        companyName,
        sector,
        industry,
        JSON.stringify(themes),
        JSON.stringify(commodities),
        JSON.stringify(countries),
        JSON.stringify(aliases),
        isActive,
      ]
    );

    insertedOrUpdated += 1;
  }

  if (logger?.info) {
    logger.info("entity_map upsert completed", {
      insertedOrUpdated,
    });
  }

  return { insertedOrUpdated };
}

async function loadEntityMapBySymbols(symbols = []) {
  const normalized = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))];
  if (!normalized.length) return {};

  const res = await pool.query(
    `
    SELECT
      symbol,
      company_name,
      sector,
      industry,
      themes,
      commodities,
      countries,
      aliases,
      is_active,
      created_at,
      updated_at
    FROM entity_map
    WHERE symbol = ANY($1::text[])
    `,
    [normalized]
  );

  const bySymbol = {};
  for (const row of res.rows || []) {
    bySymbol[row.symbol] = {
      symbol: row.symbol,
      companyName: row.company_name ?? null,
      sector: row.sector ?? null,
      industry: row.industry ?? null,
      themes: Array.isArray(row.themes) ? row.themes : [],
      commodities: Array.isArray(row.commodities) ? row.commodities : [],
      countries: Array.isArray(row.countries) ? row.countries : [],
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      isActive: row.is_active ?? true,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }

  return bySymbol;
}

async function loadAllEntityMapEntries(limit = 1000) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 10000));

  const res = await pool.query(
    `
    SELECT
      symbol,
      company_name,
      sector,
      industry,
      themes,
      commodities,
      countries,
      aliases,
      is_active,
      created_at,
      updated_at
    FROM entity_map
    ORDER BY symbol ASC
    LIMIT $1
    `,
    [safeLimit]
  );

  return (res.rows || []).map((row) => ({
    symbol: row.symbol,
    companyName: row.company_name ?? null,
    sector: row.sector ?? null,
    industry: row.industry ?? null,
    themes: Array.isArray(row.themes) ? row.themes : [],
    commodities: Array.isArray(row.commodities) ? row.commodities : [],
    countries: Array.isArray(row.countries) ? row.countries : [],
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    isActive: row.is_active ?? true,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }));
}

async function findEntityMatches(text, limit = 25) {
  const rawText = String(text || "").trim().toLowerCase();
  if (!rawText) return [];

  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));

  const res = await pool.query(
    `
    SELECT
      symbol,
      company_name,
      sector,
      industry,
      themes,
      commodities,
      countries,
      aliases,
      is_active,
      created_at,
      updated_at
    FROM entity_map
    WHERE
      LOWER(symbol) LIKE $1
      OR LOWER(COALESCE(company_name, '')) LIKE $1
    ORDER BY symbol ASC
    LIMIT $2
    `,
    [`%${rawText}%`, safeLimit]
  );

  const directMatches = (res.rows || []).map((row) => ({
    symbol: row.symbol,
    companyName: row.company_name ?? null,
    sector: row.sector ?? null,
    industry: row.industry ?? null,
    themes: Array.isArray(row.themes) ? row.themes : [],
    commodities: Array.isArray(row.commodities) ? row.commodities : [],
    countries: Array.isArray(row.countries) ? row.countries : [],
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    isActive: row.is_active ?? true,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }));

  if (directMatches.length >= safeLimit) {
    return directMatches.slice(0, safeLimit);
  }

  const allEntries = await loadAllEntityMapEntries(5000);

  const aliasMatches = allEntries.filter((entry) => {
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    const themes = Array.isArray(entry.themes) ? entry.themes : [];

    return (
      aliases.some((alias) => String(alias).toLowerCase().includes(rawText)) ||
      themes.some((theme) => String(theme).toLowerCase().includes(rawText))
    );
  });

  const merged = [];
  const seen = new Set();

  for (const item of [...directMatches, ...aliasMatches]) {
    const symbol = normalizeSymbol(item?.symbol);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    merged.push(item);
    if (merged.length >= safeLimit) break;
  }

  return merged;
}

module.exports = {
  initEntityMapTable,
  upsertEntityMapEntries,
  loadEntityMapBySymbols,
  loadAllEntityMapEntries,
  findEntityMatches,
};
