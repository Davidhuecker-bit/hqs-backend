"use strict";

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value, maxLength = 5000) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;
  return text.slice(0, maxLength);
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;

  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  return fallback;
}

async function initSecEdgarTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sec_edgar_companies (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      cik TEXT NOT NULL,
      company_name TEXT,
      sic TEXT,
      sic_description TEXT,
      entity_type TEXT,
      fiscal_year_end TEXT,
      tickers JSONB DEFAULT '[]'::jsonb,
      exchanges JSONB DEFAULT '[]'::jsonb,
      filings_meta JSONB DEFAULT '{}'::jsonb,
      raw_submissions JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sec_edgar_filing_signals (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      cik TEXT NOT NULL,
      accession_number TEXT NOT NULL,
      form_type TEXT,
      filing_date DATE,
      report_date DATE,
      primary_document TEXT,
      primary_doc_description TEXT,
      is_xbrl BOOLEAN,
      is_inline_xbrl BOOLEAN,
      signal JSONB DEFAULT '{}'::jsonb,
      raw_filing JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sec_edgar_company_facts (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      cik TEXT NOT NULL,
      taxonomy TEXT,
      fact_name TEXT NOT NULL,
      unit TEXT,
      end_date DATE,
      start_date DATE,
      filed_at DATE,
      accepted_at TIMESTAMP,
      fiscal_year TEXT,
      fiscal_period TEXT,
      form_type TEXT,
      frame TEXT,
      value_numeric DOUBLE PRECISION,
      value_text TEXT,
      value_type TEXT,
      raw_fact JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'sec_edgar_companies_cik_key'
      ) THEN
        ALTER TABLE sec_edgar_companies
        DROP CONSTRAINT sec_edgar_companies_cik_key;
      END IF;
    END
    $$;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'sec_edgar_filing_signals_accession_number_key'
      ) THEN
        ALTER TABLE sec_edgar_filing_signals
        DROP CONSTRAINT sec_edgar_filing_signals_accession_number_key;
      END IF;
    END
    $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sec_edgar_filing_signals_symbol_date
    ON sec_edgar_filing_signals (symbol, filing_date DESC);
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sec_edgar_filing_signals_symbol_accession
    ON sec_edgar_filing_signals (symbol, accession_number);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sec_edgar_company_facts_symbol_fact
    ON sec_edgar_company_facts (symbol, fact_name, end_date DESC);
  `);

  if (logger?.info) logger.info("sec_edgar tables ready");
}

async function upsertSecEdgarCompanySubmission(entry) {
  const symbol = normalizeSymbol(entry?.symbol);
  const cik = normalizeText(entry?.cik, 20);

  if (!symbol || !cik) {
    return { insertedOrUpdated: 0 };
  }

  await pool.query(
    `
    INSERT INTO sec_edgar_companies (
      symbol,
      cik,
      company_name,
      sic,
      sic_description,
      entity_type,
      fiscal_year_end,
      tickers,
      exchanges,
      filings_meta,
      raw_submissions,
      created_at,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,NOW(),NOW())
    ON CONFLICT (symbol)
    DO UPDATE SET
      cik = EXCLUDED.cik,
      company_name = EXCLUDED.company_name,
      sic = EXCLUDED.sic,
      sic_description = EXCLUDED.sic_description,
      entity_type = EXCLUDED.entity_type,
      fiscal_year_end = EXCLUDED.fiscal_year_end,
      tickers = EXCLUDED.tickers,
      exchanges = EXCLUDED.exchanges,
      filings_meta = EXCLUDED.filings_meta,
      raw_submissions = EXCLUDED.raw_submissions,
      updated_at = NOW()
    `,
    [
      symbol,
      cik,
      normalizeText(entry?.companyName, 255),
      normalizeText(entry?.sic, 20),
      normalizeText(entry?.sicDescription, 255),
      normalizeText(entry?.entityType, 50),
      normalizeText(entry?.fiscalYearEnd, 10),
      JSON.stringify(Array.isArray(entry?.tickers) ? entry.tickers : []),
      JSON.stringify(Array.isArray(entry?.exchanges) ? entry.exchanges : []),
      JSON.stringify(safeJson(entry?.filingsMeta, {})),
      JSON.stringify(safeJson(entry?.rawSubmissions, {})),
    ]
  );

  return { insertedOrUpdated: 1 };
}

async function replaceSecEdgarFilingSignals(symbol, cik, entries = []) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedCik = normalizeText(cik, 20);

  if (!normalizedSymbol || !normalizedCik) {
    return { insertedOrUpdated: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM sec_edgar_filing_signals WHERE symbol = $1`, [normalizedSymbol]);

    let insertedOrUpdated = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const accessionNumber = normalizeText(entry?.accessionNumber, 40);
      if (!accessionNumber) continue;

      await client.query(
        `
        INSERT INTO sec_edgar_filing_signals (
          symbol,
          cik,
          accession_number,
          form_type,
          filing_date,
          report_date,
          primary_document,
          primary_doc_description,
          is_xbrl,
          is_inline_xbrl,
          signal,
          raw_filing,
          created_at,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,NOW(),NOW())
        `,
        [
          normalizedSymbol,
          normalizedCik,
          accessionNumber,
          normalizeText(entry?.formType, 30),
          normalizeDate(entry?.filingDate),
          normalizeDate(entry?.reportDate),
          normalizeText(entry?.primaryDocument, 255),
          normalizeText(entry?.primaryDocDescription, 255),
          entry?.isXbrl === true,
          entry?.isInlineXbrl === true,
          JSON.stringify(safeJson(entry?.signal, {})),
          JSON.stringify(safeJson(entry?.rawFiling, {})),
        ]
      );
      insertedOrUpdated += 1;
    }

    await client.query("COMMIT");
    return { insertedOrUpdated };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function replaceSecEdgarCompanyFacts(symbol, cik, entries = []) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedCik = normalizeText(cik, 20);

  if (!normalizedSymbol || !normalizedCik) {
    return { insertedOrUpdated: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM sec_edgar_company_facts WHERE symbol = $1`, [normalizedSymbol]);

    let insertedOrUpdated = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const factName = normalizeText(entry?.factName, 120);
      if (!factName) continue;

      const numericValue = Number(entry?.value);
      const valueType =
        typeof entry?.value === "number"
          ? "number"
          : typeof entry?.value === "string"
            ? "string"
            : entry?.value == null
              ? null
              : typeof entry?.value;

      await client.query(
        `
        INSERT INTO sec_edgar_company_facts (
          symbol,
          cik,
          taxonomy,
          fact_name,
          unit,
          end_date,
          start_date,
          filed_at,
          accepted_at,
          fiscal_year,
          fiscal_period,
          form_type,
          frame,
          value_numeric,
          value_text,
          value_type,
          raw_fact,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,NOW())
        `,
        [
          normalizedSymbol,
          normalizedCik,
          normalizeText(entry?.taxonomy, 50),
          factName,
          normalizeText(entry?.unit, 30),
          normalizeDate(entry?.endDate),
          normalizeDate(entry?.startDate),
          normalizeDate(entry?.filedAt),
          normalizeTimestamp(entry?.acceptedAt),
          normalizeText(entry?.fiscalYear, 20),
          normalizeText(entry?.fiscalPeriod, 20),
          normalizeText(entry?.formType, 30),
          normalizeText(entry?.frame, 40),
          Number.isFinite(numericValue) ? numericValue : null,
          Number.isFinite(numericValue) ? null : normalizeText(entry?.value, 5000),
          normalizeText(valueType, 20),
          JSON.stringify(safeJson(entry?.rawFact, {})),
        ]
      );
      insertedOrUpdated += 1;
    }

    await client.query("COMMIT");
    return { insertedOrUpdated };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadSecEdgarSnapshotBySymbol(symbol, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const filingLimit = Math.max(1, Math.min(Number(options?.filingLimit) || 10, 50));
  const factLimit = Math.max(1, Math.min(Number(options?.factLimit) || 25, 100));

  if (!normalizedSymbol) {
    return null;
  }

  const [companyRes, filingsRes, factsRes] = await Promise.all([
    pool.query(
      `
      SELECT
        symbol,
        cik,
        company_name,
        sic,
        sic_description,
        entity_type,
        fiscal_year_end,
        tickers,
        exchanges,
        filings_meta,
        updated_at
      FROM sec_edgar_companies
      WHERE symbol = $1
      LIMIT 1
      `,
      [normalizedSymbol]
    ),
    pool.query(
      `
      SELECT
        accession_number,
        form_type,
        filing_date,
        report_date,
        primary_document,
        primary_doc_description,
        is_xbrl,
        is_inline_xbrl,
        signal,
        updated_at
      FROM sec_edgar_filing_signals
      WHERE symbol = $1
      ORDER BY filing_date DESC NULLS LAST, updated_at DESC
      LIMIT $2
      `,
      [normalizedSymbol, filingLimit]
    ),
    pool.query(
      `
      SELECT
        taxonomy,
        fact_name,
        unit,
        end_date,
        start_date,
        filed_at,
        accepted_at,
        fiscal_year,
        fiscal_period,
        form_type,
        frame,
        value_numeric,
        value_text,
        value_type
      FROM sec_edgar_company_facts
      WHERE symbol = $1
      ORDER BY end_date DESC NULLS LAST, filed_at DESC NULLS LAST, fact_name ASC
      LIMIT $2
      `,
      [normalizedSymbol, factLimit]
    ),
  ]);

  if (!companyRes.rows.length) {
    return null;
  }

  const company = companyRes.rows[0];
  return {
    company: {
      symbol: company.symbol,
      cik: company.cik,
      companyName: company.company_name ?? null,
      sic: company.sic ?? null,
      sicDescription: company.sic_description ?? null,
      entityType: company.entity_type ?? null,
      fiscalYearEnd: company.fiscal_year_end ?? null,
      tickers: Array.isArray(company.tickers) ? company.tickers : [],
      exchanges: Array.isArray(company.exchanges) ? company.exchanges : [],
      filingsMeta: safeJson(company.filings_meta, {}),
      updatedAt: company.updated_at ? new Date(company.updated_at).toISOString() : null,
    },
    filingSignals: (filingsRes.rows || []).map((row) => ({
      accessionNumber: row.accession_number,
      formType: row.form_type ?? null,
      filingDate: row.filing_date ? new Date(row.filing_date).toISOString().slice(0, 10) : null,
      reportDate: row.report_date ? new Date(row.report_date).toISOString().slice(0, 10) : null,
      primaryDocument: row.primary_document ?? null,
      primaryDocDescription: row.primary_doc_description ?? null,
      isXbrl: row.is_xbrl ?? false,
      isInlineXbrl: row.is_inline_xbrl ?? false,
      signal: safeJson(row.signal, {}),
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    })),
    companyFacts: (factsRes.rows || []).map((row) => ({
      taxonomy: row.taxonomy ?? null,
      factName: row.fact_name,
      unit: row.unit ?? null,
      endDate: row.end_date ? new Date(row.end_date).toISOString().slice(0, 10) : null,
      startDate: row.start_date ? new Date(row.start_date).toISOString().slice(0, 10) : null,
      filedAt: row.filed_at ? new Date(row.filed_at).toISOString().slice(0, 10) : null,
      acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
      fiscalYear: row.fiscal_year ?? null,
      fiscalPeriod: row.fiscal_period ?? null,
      formType: row.form_type ?? null,
      frame: row.frame ?? null,
      value: row.value_numeric ?? row.value_text ?? null,
      valueType: row.value_type ?? null,
    })),
  };
}

module.exports = {
  initSecEdgarTables,
  loadSecEdgarSnapshotBySymbol,
  replaceSecEdgarCompanyFacts,
  replaceSecEdgarFilingSignals,
  upsertSecEdgarCompanySubmission,
};
