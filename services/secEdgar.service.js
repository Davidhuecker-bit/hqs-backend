"use strict";

const axios = require("axios");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const {
  initSecEdgarTables,
  loadSecEdgarSnapshotBySymbol,
  replaceSecEdgarCompanyFacts,
  replaceSecEdgarFilingSignals,
  upsertSecEdgarCompanySubmission,
} = require("./secEdgar.repository");

const SEC_SUBMISSIONS_BASE_URL =
  process.env.SEC_EDGAR_SUBMISSIONS_BASE_URL || "https://data.sec.gov/submissions";
const SEC_COMPANY_FACTS_BASE_URL =
  process.env.SEC_EDGAR_COMPANY_FACTS_BASE_URL || "https://data.sec.gov/api/xbrl/companyfacts";
const SEC_TICKER_MAP_URL =
  process.env.SEC_EDGAR_TICKER_MAP_URL || "https://www.sec.gov/files/company_tickers.json";
const SEC_TIMEOUT_MS = Math.max(5000, Math.min(Number(process.env.SEC_EDGAR_TIMEOUT_MS || 15000), 60000));
const SEC_USER_AGENT = String(process.env.SEC_EDGAR_USER_AGENT || "").trim();
const DEFAULT_FILING_LIMIT = 12;
const DEFAULT_FACT_LIMIT = 30;
const DEFAULT_FACTS_PER_METRIC = 2;
const MAX_FILING_LIMIT = 25;
const MAX_FACT_LIMIT = 100;
const MAX_FACTS_PER_METRIC = 5;

const CORE_FACTS = [
  { taxonomy: "us-gaap", factNames: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"] },
  { taxonomy: "us-gaap", factNames: ["NetIncomeLoss", "ProfitLoss"] },
  { taxonomy: "us-gaap", factNames: ["Assets"] },
  { taxonomy: "us-gaap", factNames: ["AssetsCurrent"] },
  { taxonomy: "us-gaap", factNames: ["Liabilities"] },
  { taxonomy: "us-gaap", factNames: ["LiabilitiesCurrent"] },
  { taxonomy: "us-gaap", factNames: ["StockholdersEquity"] },
  { taxonomy: "us-gaap", factNames: ["CashAndCashEquivalentsAtCarryingValue"] },
  { taxonomy: "us-gaap", factNames: ["NetCashProvidedByUsedInOperatingActivities"] },
  { taxonomy: "us-gaap", factNames: ["OperatingIncomeLoss"] },
  { taxonomy: "us-gaap", factNames: ["EarningsPerShareBasic"] },
  { taxonomy: "us-gaap", factNames: ["WeightedAverageNumberOfSharesOutstandingBasic"] },
];

let tickerMapCache = {
  expiresAt: 0,
  bySymbol: new Map(),
};

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function cleanText(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length ? text : null;
}

function padCik(value) {
  const cik = String(value || "").replace(/\D/g, "");
  return cik ? cik.padStart(10, "0") : null;
}

function buildSecHeaders() {
  if (!SEC_USER_AGENT) {
    const error = new Error(
      "SEC_EDGAR_USER_AGENT must be configured with a valid contact email before calling SEC EDGAR"
    );
    error.statusCode = 500;
    throw error;
  }

  return {
    "User-Agent": SEC_USER_AGENT,
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
  };
}

async function fetchJson(url) {
  const response = await axios.get(url, {
    timeout: SEC_TIMEOUT_MS,
    headers: buildSecHeaders(),
  });

  return response?.data;
}

async function loadTickerMap(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && tickerMapCache.expiresAt > now && tickerMapCache.bySymbol.size) {
    return tickerMapCache.bySymbol;
  }

  const payload = await fetchJson(SEC_TICKER_MAP_URL);
  const bySymbol = new Map();

  if (payload && typeof payload === "object") {
    for (const value of Object.values(payload)) {
      const symbol = normalizeSymbol(value?.ticker);
      const cik = padCik(value?.cik_str);
      if (!symbol || !cik) continue;

      bySymbol.set(symbol, {
        symbol,
        cik,
        companyName: cleanText(value?.title),
      });
    }
  }

  tickerMapCache = {
    expiresAt: now + 24 * 60 * 60 * 1000,
    bySymbol,
  };

  return bySymbol;
}

async function resolveSecCompany(symbol) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return null;

  const map = await loadTickerMap();
  return map.get(normalizedSymbol) || null;
}

async function fetchCompanySubmissions(cik) {
  const paddedCik = padCik(cik);
  if (!paddedCik) return null;
  return fetchJson(`${SEC_SUBMISSIONS_BASE_URL}/CIK${paddedCik}.json`);
}

async function fetchCompanyFacts(cik) {
  const paddedCik = padCik(cik);
  if (!paddedCik) return null;

  try {
    return await fetchJson(`${SEC_COMPANY_FACTS_BASE_URL}/CIK${paddedCik}.json`);
  } catch (error) {
    if (error?.response?.status === 404) {
      if (logger?.warn) {
        logger.warn("SEC company facts unavailable", {
          cik: paddedCik,
          status: 404,
        });
      }
      return null;
    }

    throw error;
  }
}

function normalizeArrayField(value) {
  return Array.isArray(value) ? value : [];
}

function buildCompanySubmissionRecord(symbol, resolvedCompany, submissions) {
  const recent = submissions?.filings?.recent || {};
  return {
    symbol,
    cik: padCik(submissions?.cik || resolvedCompany?.cik),
    companyName: cleanText(submissions?.name || resolvedCompany?.companyName),
    sic: cleanText(submissions?.sic),
    sicDescription: cleanText(submissions?.sicDescription),
    entityType: cleanText(submissions?.entityType),
    fiscalYearEnd: cleanText(submissions?.fiscalYearEnd),
    tickers: normalizeArrayField(submissions?.tickers).map(normalizeSymbol).filter(Boolean),
    exchanges: normalizeArrayField(submissions?.exchanges).map(cleanText).filter(Boolean),
    filingsMeta: {
      latestAccessionNumber: cleanText(recent?.accessionNumber?.[0]),
      latestForm: cleanText(recent?.form?.[0]),
      latestFilingDate: cleanText(recent?.filingDate?.[0]),
      recentCount: Array.isArray(recent?.accessionNumber) ? recent.accessionNumber.length : 0,
    },
    rawSubmissions: submissions,
  };
}

function classifyFiling(formType) {
  const form = cleanText(formType);
  if (!form) return { category: "other", priority: 0 };
  if (form === "10-K" || form === "10-K/A") return { category: "annual-report", priority: 3 };
  if (form === "10-Q" || form === "10-Q/A") return { category: "quarterly-report", priority: 2 };
  if (form === "8-K") return { category: "current-report", priority: 1 };
  return { category: "other", priority: 0 };
}

function diffDays(fromValue, toValue) {
  if (!fromValue || !toValue) return null;
  const from = new Date(fromValue);
  const to = new Date(toValue);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function extractFilingSignals(symbol, cik, submissions, filingLimit = DEFAULT_FILING_LIMIT) {
  const recent = submissions?.filings?.recent || {};
  const accessionNumbers = Array.isArray(recent?.accessionNumber) ? recent.accessionNumber : [];
  const entries = [];
  const nowIso = new Date().toISOString();

  for (let index = 0; index < accessionNumbers.length; index += 1) {
    const formType = cleanText(recent?.form?.[index]);
    const filingDate = cleanText(recent?.filingDate?.[index]);
    const reportDate = cleanText(recent?.reportDate?.[index]);
    const { category, priority } = classifyFiling(formType);

    if (!priority) continue;

    entries.push({
      symbol,
      cik,
      accessionNumber: cleanText(accessionNumbers[index]),
      formType,
      filingDate,
      reportDate,
      primaryDocument: cleanText(recent?.primaryDocument?.[index]),
      primaryDocDescription: cleanText(recent?.primaryDocDescription?.[index]),
      isXbrl: Number(recent?.isXBRL?.[index]) === 1,
      isInlineXbrl: Number(recent?.isInlineXBRL?.[index]) === 1,
      signal: {
        category,
        priority,
        isAmendment: formType?.endsWith("/A") || false,
        filingLagDays: diffDays(reportDate, filingDate),
        recencyDays: diffDays(filingDate, nowIso),
        hasStructuredData: Number(recent?.isXBRL?.[index]) === 1 || Number(recent?.isInlineXBRL?.[index]) === 1,
      },
      rawFiling: {
        accessionNumber: accessionNumbers[index],
        form: recent?.form?.[index] ?? null,
        filingDate: recent?.filingDate?.[index] ?? null,
        reportDate: recent?.reportDate?.[index] ?? null,
        primaryDocument: recent?.primaryDocument?.[index] ?? null,
        primaryDocDescription: recent?.primaryDocDescription?.[index] ?? null,
      },
    });
  }

  return entries
    .sort((left, right) => {
      const leftDate = left.filingDate ? new Date(left.filingDate).getTime() : 0;
      const rightDate = right.filingDate ? new Date(right.filingDate).getTime() : 0;
      return rightDate - leftDate;
    })
    .slice(0, Math.max(1, Math.min(Number(filingLimit) || DEFAULT_FILING_LIMIT, MAX_FILING_LIMIT)));
}

function scoreFactObservation(item) {
  const form = cleanText(item?.form);
  if (form === "10-K") return 3;
  if (form === "10-Q") return 2;
  if (form === "8-K") return 1;
  return 0;
}

function extractCompanyFacts(symbol, cik, companyFacts, options = {}) {
  const factsPerMetric = Math.max(
    1,
    Math.min(Number(options?.factsPerMetric) || DEFAULT_FACTS_PER_METRIC, MAX_FACTS_PER_METRIC)
  );
  const hardLimit = Math.max(1, Math.min(Number(options?.factLimit) || DEFAULT_FACT_LIMIT, MAX_FACT_LIMIT));
  const results = [];

  for (const descriptor of CORE_FACTS) {
    const taxonomyFacts = companyFacts?.facts?.[descriptor.taxonomy];
    if (!taxonomyFacts || typeof taxonomyFacts !== "object") continue;

    for (const factName of descriptor.factNames) {
      const factDefinition = taxonomyFacts?.[factName];
      if (!factDefinition?.units || typeof factDefinition.units !== "object") continue;

      const flattened = [];

      for (const [unit, entries] of Object.entries(factDefinition.units)) {
        if (!Array.isArray(entries)) continue;

        for (const entry of entries) {
          flattened.push({
            symbol,
            cik,
            taxonomy: descriptor.taxonomy,
            factName,
            unit,
            endDate: entry?.end ?? null,
            startDate: entry?.start ?? null,
            filedAt: entry?.filed ?? null,
            acceptedAt: entry?.accepted ?? null,
            fiscalYear: entry?.fy != null ? String(entry.fy) : null,
            fiscalPeriod: cleanText(entry?.fp),
            formType: cleanText(entry?.form),
            frame: cleanText(entry?.frame),
            value: entry?.val ?? null,
            rawFact: entry,
          });
        }
      }

      if (!flattened.length) continue;

      flattened
        .sort((left, right) => {
          const scoreDiff = scoreFactObservation(right) - scoreFactObservation(left);
          if (scoreDiff !== 0) return scoreDiff;

          const rightDate = right.endDate ? new Date(right.endDate).getTime() : 0;
          const leftDate = left.endDate ? new Date(left.endDate).getTime() : 0;
          if (rightDate !== leftDate) return rightDate - leftDate;

          const rightFiled = right.filedAt ? new Date(right.filedAt).getTime() : 0;
          const leftFiled = left.filedAt ? new Date(left.filedAt).getTime() : 0;
          return rightFiled - leftFiled;
        })
        .slice(0, factsPerMetric)
        .forEach((entry) => results.push(entry));

      break;
    }
  }

  return results.slice(0, hardLimit);
}

async function refreshSecEdgarSnapshot(symbol, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) {
    const error = new Error('The "symbol" parameter is required');
    error.statusCode = 400;
    throw error;
  }

  await initSecEdgarTables();

  const resolvedCompany = await resolveSecCompany(normalizedSymbol);
  if (!resolvedCompany?.cik) {
    const error = new Error(`SEC EDGAR mapping not found for symbol ${normalizedSymbol}`);
    error.statusCode = 404;
    throw error;
  }

  const submissions = await fetchCompanySubmissions(resolvedCompany.cik);
  if (!submissions) {
    const error = new Error(`SEC submissions not found for symbol ${normalizedSymbol}`);
    error.statusCode = 404;
    throw error;
  }

  const companyFacts = await fetchCompanyFacts(resolvedCompany.cik);
  const companySubmissionRecord = buildCompanySubmissionRecord(
    normalizedSymbol,
    resolvedCompany,
    submissions
  );
  const filingSignals = extractFilingSignals(
    normalizedSymbol,
    resolvedCompany.cik,
    submissions,
    options?.filingLimit
  );
  const facts = companyFacts
    ? extractCompanyFacts(normalizedSymbol, resolvedCompany.cik, companyFacts, options)
    : [];

  await upsertSecEdgarCompanySubmission(companySubmissionRecord);
  await replaceSecEdgarFilingSignals(normalizedSymbol, resolvedCompany.cik, filingSignals);
  await replaceSecEdgarCompanyFacts(normalizedSymbol, resolvedCompany.cik, facts);

  return {
    symbol: normalizedSymbol,
    cik: resolvedCompany.cik,
    filingsStored: filingSignals.length,
    factsStored: facts.length,
  };
}

async function getSecEdgarSnapshotBySymbol(symbol, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return null;

  if (String(options?.refresh || "false").toLowerCase() === "true") {
    await refreshSecEdgarSnapshot(normalizedSymbol, options);
  }

  return loadSecEdgarSnapshotBySymbol(normalizedSymbol, options);
}

module.exports = {
  CORE_FACTS,
  extractCompanyFacts,
  extractFilingSignals,
  getSecEdgarSnapshotBySymbol,
  refreshSecEdgarSnapshot,
  resolveSecCompany,
};
