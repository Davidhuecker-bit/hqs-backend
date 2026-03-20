"use strict";

/*
  Guardian Service – OpenAI Analysis Consumer

  Wraps the OpenAI GPT model to produce a human-readable stock analysis
  based on the finalConviction, finalRating, and finalDecision outputs
  from integrationEngine, supplemented by the raw HQS breakdown.

  Verantwortung: Consume integrationEngine output → generate natural-language
  analysis via OpenAI Guardian AI prompt.  No scoring, no pipeline state.

  Rolle: Consumer (letzte Schicht – liest fertige Engine-Outputs, schreibt nichts zurück)
*/

const OpenAI = require("openai");

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

  // Use integrationEngine outputs when available; fall back to raw HQS fields.
  const finalConviction = marketData?.finalConviction ?? null;
  const finalRating = marketData?.finalRating ?? null;
  const finalDecision = marketData?.finalDecision ?? null;
  const whyInteresting = Array.isArray(marketData?.whyInteresting) && marketData.whyInteresting.length
    ? marketData.whyInteresting.join(", ")
    : null;
  const hqsScore = marketData?.hqsScore ?? null;
  const regime = marketData?.regime ?? null;
  const hqsBreakdown = marketData?.hqsBreakdown ?? null;
  const trend = marketData?.trend ?? null;

  function buildConvictionBlock() {
    if (finalConviction != null) {
      const ratingLabel = finalRating || "–";
      const decisionLabel = finalDecision || "–";
      return `Final Conviction: ${finalConviction} (${ratingLabel}, Entscheidung: ${decisionLabel})`;
    }
    return `HQS Score: ${hqsScore ?? "–"}`;
  }

  const convictionBlock = buildConvictionBlock();

  const regimeBlock = regime
    ? `Markt-Regime: ${regime}`
    : "";

  const breakdownBlock = hqsBreakdown
    ? `HQS-Breakdown: Momentum ${hqsBreakdown.momentum ?? "–"}, Quality ${hqsBreakdown.quality ?? "–"}, Stability ${hqsBreakdown.stability ?? "–"}, Relative ${hqsBreakdown.relative ?? "–"}`
    : "";

  const trendBlock = trend ? `Trend: ${trend}` : "";

  const whyBlock = whyInteresting
    ? `Auffälligkeiten (Integration Engine): ${whyInteresting}`
    : "";

  const contextLines = [convictionBlock, regimeBlock, breakdownBlock, trendBlock, whyBlock]
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

module.exports = { analyzeStockWithGuardian };
