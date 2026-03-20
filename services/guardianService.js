"use strict";

/*
  Guardian Service – OpenAI Analysis Consumer

  Wraps the OpenAI GPT model to produce a human-readable stock analysis
  based on the canonical integrationEngine output fields:
    finalConviction, finalConfidence, finalRating, finalDecision,
    whyInteresting, components (conviction breakdown), hqsScore, regime.

  Verantwortung: Consume integrationEngine canonical output → generate
  natural-language analysis via OpenAI Guardian AI prompt.
  No scoring, no pipeline state.

  Rolle: Consumer (letzte Schicht – liest fertige Engine-Outputs, schreibt nichts zurück)
*/

const OpenAI = require("openai");

// ── Canonical field contract ─────────────────────────────────────────────────
// These are the integrationEngine output fields that Guardian depends on.
// detectMissingCanonicalFields() surfaces gaps so callers know when the
// analysis is based on partial data.
const GUARDIAN_CANONICAL_FIELDS = [
  "finalConviction",
  "finalConfidence",
  "finalRating",
  "finalDecision",
  "whyInteresting",
  "components",
];

/**
 * Returns the list of canonical fields that are absent from marketData.
 * An empty result means the full integrationEngine output is present.
 *
 * @param {object|null} marketData
 * @returns {string[]}  names of missing fields
 */
function detectMissingCanonicalFields(marketData) {
  return GUARDIAN_CANONICAL_FIELDS.filter((field) => marketData?.[field] == null);
}

let client = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return client;
}

async function analyzeStockWithGuardian(context) {
  const {
    symbol,
    marketData,
  } = context;

  // Read canonical integrationEngine output fields.
  const finalConviction = marketData?.finalConviction ?? null;
  const finalConfidence = marketData?.finalConfidence ?? null;
  const finalRating = marketData?.finalRating ?? null;
  const finalDecision = marketData?.finalDecision ?? null;
  const whyInteresting = Array.isArray(marketData?.whyInteresting) && marketData.whyInteresting.length
    ? marketData.whyInteresting.join(", ")
    : null;
  const hqsScore = marketData?.hqsScore ?? null;
  const regime = marketData?.regime ?? null;
  const components = marketData?.components ?? null;

  // ── Fallback guard ───────────────────────────────────────────────────────
  // Surface any missing canonical fields so pipeline gaps are visible.
  const missingFields = detectMissingCanonicalFields(marketData);
  if (missingFields.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[guardianService] ${symbol}: missing canonical fields: ${missingFields.join(", ")}`
    );
  }
  // If both the primary conviction score and the fallback hqsScore are absent
  // there is no scoring data to base an analysis on.  Return a clear degraded
  // response instead of invoking the AI with empty/null inputs.
  if (finalConviction == null && hqsScore == null) {
    return `[Guardian: degraded – keine Scoring-Daten für ${symbol || "?"} verfügbar. Fehlende Felder: ${missingFields.join(", ")}]`;
  }

  function buildConvictionBlock() {
    if (finalConviction != null) {
      const ratingLabel = finalRating || "–";
      const decisionLabel = finalDecision || "–";
      const confidenceLabel = finalConfidence != null ? `, Confidence: ${finalConfidence}` : "";
      return `Final Conviction: ${finalConviction} (${ratingLabel}, Entscheidung: ${decisionLabel}${confidenceLabel})`;
    }
    return `HQS Score: ${hqsScore ?? "–"}`;
  }

  const convictionBlock = buildConvictionBlock();

  const regimeBlock = regime
    ? `Markt-Regime: ${regime}`
    : "";

  const componentsBlock = components
    ? `Conviction-Breakdown: HQS ${components.hqs ?? "–"}, AI ${components.ai ?? "–"}, StrategyAdj ${components.strategyAdjusted ?? "–"}, Resilience ${components.resilience != null ? Math.round(components.resilience * 100) : "–"}, NewsStrength ${components.newsStrength ?? "–"}`
    : "";

  const whyBlock = whyInteresting
    ? `Auffälligkeiten (Integration Engine): ${whyInteresting}`
    : "";

  const contextLines = [convictionBlock, regimeBlock, componentsBlock, whyBlock]
    .filter(Boolean)
    .join("\n");

  const prompt = `
Du bist Guardian AI – ein professionelles Finanz-Analyse-System, das auf dem HQS-Framework aufbaut.

Erkläre die folgenden finalen Marktdaten:

Symbol: ${symbol}

${contextLines}

Vollständige Rohdaten:
${JSON.stringify(marketData, null, 2)}

Erstelle eine strukturierte Erklärung mit:

1. Bewertung: Bullish / Neutral / Bearish (konsistent mit Regime und HQS-Score)
2. Risiko-Level: Niedrig / Mittel / Hoch
3. Kurze Begründung (3-5 Sätze, mit Bezug auf HQS-Score, Regime und Trend)
4. Handlungsempfehlung (konsistent mit dem finalen Conviction-Score falls vorhanden)
`;

  const response = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  return response.choices[0].message.content;
}

module.exports = { analyzeStockWithGuardian, detectMissingCanonicalFields };
