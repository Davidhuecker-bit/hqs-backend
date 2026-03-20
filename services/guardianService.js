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

  // Step 4: read portfolio context if present (pass-through from opportunity scanner).
  const portfolioContext = marketData?.portfolioContext ?? context?.portfolioContext ?? null;

  // Step 4b: read delta context if present (pass-through from opportunity scanner).
  const deltaContext = marketData?.deltaContext ?? context?.deltaContext ?? null;

  // Step 4c: read next action hint if present (computed by opportunityScanner).
  const nextAction = marketData?.nextAction ?? context?.nextAction ?? null;

  // Step 5b: read action-orchestration if present (computed by opportunityScanner).
  const actionOrchestration = marketData?.actionOrchestration ?? context?.actionOrchestration ?? null;

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

  // Step 4: portfolio context block – extended with portfolio intelligence signals.
  const portfolioBlock = portfolioContext
    ? `Portfolio-Kontext: ${portfolioContext.portfolioContextLabel || "–"}` +
      ` (portfolioRole: ${portfolioContext.portfolioRole || "–"}` +
      `, concentrationRisk: ${portfolioContext.concentrationRisk || "–"}` +
      `, diversificationBenefit: ${portfolioContext.diversificationBenefit ? "ja" : "nein"}` +
      `, sectorOverlap: ${portfolioContext.sectorOverlap ? "ja" : "nein"}` +
      `, portfolioPriority: ${portfolioContext.portfolioPriority || "–"})`
    : "";

  // Step 4b: delta block – explains what changed since the last engine run.
  // Only added when a non-stable change type is present.
  const DELTA_CHANGE_LABELS = {
    new_signal:             "Neu im Scanner – erste Prüfung empfohlen",
    gaining_relevance:      "Conviction gestiegen – relevanter als zuletzt",
    risk_increased:         "Risiko erhöht – Konzentrationsrisiko oder Score-Rückgang",
    losing_conviction:      "Conviction gesunken – kritisch beobachten",
    portfolio_impact_changed: "Portfolio-Impact geändert – Positionseröffnung prüfen",
  };
  let deltaBlock = "";
  if (deltaContext && deltaContext.changeType && deltaContext.changeType !== "stable") {
    const changeLabel = DELTA_CHANGE_LABELS[deltaContext.changeType] || deltaContext.changeType;
    const deltaParts = [`Delta-Signal: ${changeLabel} (Priorität: ${deltaContext.deltaPriority})`];
    if (deltaContext.newToWatch)            deltaParts.push("Neu relevant");
    if (deltaContext.becameMoreRelevant)    deltaParts.push("Relevanz gestiegen");
    if (deltaContext.becameRiskier)         deltaParts.push("Risiko gestiegen");
    if (deltaContext.lostConviction)        deltaParts.push("Überzeugung verloren");
    if (deltaContext.portfolioImpactChanged) deltaParts.push("Portfolio-Fit geändert");
    if (deltaContext._convictionDelta !== null) {
      const sign = deltaContext._convictionDelta >= 0 ? "+" : "";
      deltaParts.push(`Δ Conviction: ${sign}${deltaContext._convictionDelta}`);
    }
    deltaBlock = deltaParts.join(" · ");
  }

  // Step 4c: next action block – surfaces the computed next action hint.
  function buildNextActionBlock() {
    if (!nextAction?.actionType) return "";
    const parts = [
      `Nächster Schritt: ${nextAction.nextActionLabel}`,
      `(${nextAction.actionType}, Priorität: ${nextAction.actionPriority})`,
      `– ${nextAction.actionReason}`,
    ];
    return parts.join(" ");
  }
  const nextActionBlock = buildNextActionBlock();

  // Step 5b: action-orchestration block – explains why the system chose this delivery mode.
  // Short, factual, no new prompt world – just surfaces the orchestration decision.
  const DELIVERY_MODE_LABELS = {
    briefing_and_notification: "Briefing + Sofort-Benachrichtigung (akuter Handlungsbedarf)",
    notification:  "Sofort-Benachrichtigung (zeitkritisches Signal)",
    briefing:      "Im Tages-Briefing berücksichtigt",
    passive_briefing: "Passiv beobachtet (kein akuter Bedarf)",
    none:          "Kein aktiver Hinweis",
  };
  const REVIEW_WINDOW_LABELS = {
    immediate: "sofort",
    short:     "kurzfristig (1–3 Tage)",
    medium:    "mittelfristig (1–2 Wochen)",
    long:      "langfristig (>2 Wochen)",
  };
  function buildActionOrchestrationBlock() {
    if (!actionOrchestration) return "";
    const parts = [];
    if (actionOrchestration.deliveryMode) {
      parts.push(`System-Behandlung: ${DELIVERY_MODE_LABELS[actionOrchestration.deliveryMode] || actionOrchestration.deliveryMode}`);
    }
    if (actionOrchestration.escalationLevel && actionOrchestration.escalationLevel !== "none") {
      parts.push(`Eskalationsstufe: ${actionOrchestration.escalationLevel}`);
    }
    if (actionOrchestration.followUpNeeded) {
      parts.push(`Follow-up erforderlich: ${actionOrchestration.followUpReason || "ja"}`);
    }
    if (actionOrchestration.reviewWindow) {
      parts.push(`Prüfungsfenster: ${REVIEW_WINDOW_LABELS[actionOrchestration.reviewWindow] || actionOrchestration.reviewWindow}`);
    }
    return parts.length ? parts.join(" · ") : "";
  }
  const actionOrchestrationBlock = buildActionOrchestrationBlock();

  const contextLines = [convictionBlock, regimeBlock, componentsBlock, whyBlock, portfolioBlock, deltaBlock, nextActionBlock, actionOrchestrationBlock]
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
5. Portfolio-Einordnung: Beantworte konkret, was der Portfolio-Kontext bedeutet –
   - portfolioRole="additive": bewertet ob die Aufstockung das Konzentrationsrisiko erhöht
   - portfolioRole="redundant": erklärt warum der Sektor bereits vertreten ist und ob das Risiko steigt
   - portfolioRole="diversifier": erläutert den Diversifikationsmehrwert und welchen neuen Sektor das Symbol bringt
   - portfolioRole="complement": diskutiert den optimalen Einstiegszeitpunkt für die Beobachtungsliste
   - concentrationRisk="high": explizit warnen, dass das Sektorgewicht bereits kritisch ist
   - diversificationBenefit=ja: explizit positiv auf Diversifikationsmehrwert hinweisen
   Wenn kein Portfolio-Kontext verfügbar, diesen Punkt weglassen.
6. Veränderungs-Einschätzung: Falls ein Delta-Signal vorhanden ist, erkläre präzise was sich verändert hat –
   - changeType="new_signal": Symbol ist neu im Scanner – erste Einschätzung empfehlen
   - changeType="gaining_relevance": Conviction/Relevanz ist gestiegen – Chance betonen
   - changeType="risk_increased": Risiko ist gestiegen – explizit warnen
   - changeType="losing_conviction": Überzeugung gesunken – kritisch bewerten, Vorsicht empfehlen
   - changeType="portfolio_impact_changed": Portfolio-Relevanz hat sich verändert – Konsequenz erläutern
   Wenn kein Delta-Signal vorhanden (changeType="stable"), diesen Punkt weglassen.
7. Nächster sinnvoller Schritt: Falls eine Next-Action-Empfehlung vorhanden ist, erläutere kurz warum dieser Schritt sinnvoll ist –
   - actionType="starter_position": erkläre konkret, warum jetzt ein Einstieg geprüft werden sollte
   - actionType="watchlist_upgrade": erkläre, warum das Symbol prioritär beobachtet werden sollte
   - actionType="reduce_risk": erkläre das Risiko und empfehle klar Positionsreduktion
   - actionType="avoid_adding": erkläre, warum keine weitere Aufstockung empfohlen wird
   - actionType="rebalance_review": erkläre, warum eine Rebalancing-Prüfung sinnvoll ist
   - actionType="hold": bestätige, dass keine Aktion nötig ist
   - actionType="observe": erkläre, warum nur Beobachtung empfohlen wird
   Wenn kein Next-Action-Hint vorhanden, diesen Punkt weglassen.
8. System-Einordnung: Falls Action-Orchestration vorhanden ist, erkläre kurz, warum das System diesen Behandlungsmodus gewählt hat –
   - deliveryMode="briefing_and_notification": erkläre, warum akuter Handlungsbedarf besteht und warum sowohl Briefing als auch Sofortmeldung nötig sind
   - deliveryMode="notification": erkläre, warum ein zeitkritisches Signal vorliegt, das sofort mitgeteilt werden sollte
   - deliveryMode="briefing": erkläre, warum das Signal im regulären Tages-Briefing ausreicht und keine Sofortmeldung nötig ist
   - deliveryMode="passive_briefing" oder "none": erkläre, warum kein aktiver Hinweis nötig ist und nur Beobachtung empfohlen wird
   - followUpNeeded=true: nenne konkret den empfohlenen Nachfolgeschritt und den Zeithorizont
   Wenn keine Action-Orchestration vorhanden, diesen Punkt weglassen.
`;

  const response = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  return response.choices[0].message.content;
}

module.exports = { analyzeStockWithGuardian, detectMissingCanonicalFields };
