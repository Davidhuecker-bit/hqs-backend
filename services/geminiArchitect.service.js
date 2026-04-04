"use strict";

const { GoogleGenerativeAI } = require("@google/generative-ai");

const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   Gemini configuration helpers
   ───────────────────────────────────────────── */

function isGeminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

let _client = null;

function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY – Gemini Architect is not configured");
  }
  if (!_client) {
    _client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _client;
}

function getModelName() {
  return process.env.GEMINI_MODEL || "gemini-1.5-flash";
}

/* ─────────────────────────────────────────────
   Valid modes
   ───────────────────────────────────────────── */

const VALID_MODES = [
  "layout_review",
  "presentation_review",
  "frontend_guard",
  "priority_review",
];

const DEFAULT_MODE = "layout_review";

/* ─────────────────────────────────────────────
   HQS frontend context injected into every prompt
   ───────────────────────────────────────────── */

const HQS_FRONTEND_CONTEXT = `
HQS-System-Kontext für Frontend-Architektur-Überprüfungen:

- Das HQS-System ist ein Finanz-Dashboard mit Admin-Bereich, Portfolio-Ansicht, Discovery-Engine, Tech-Radar, Chancen-Scanner und Symbol-Summaries.
- Die Oberfläche soll für alle Nutzergruppen klar, ruhig und verständlich sein – keine Informationsüberlastung.
- Wichtige View-Bereiche: Admin-Konsole, Portfolio-Depot, Symbol-Detail, Markt-Übersicht, Chancen-Liste, Tech-Radar-Board.
- Layout-Prioritäten: Status-Indikatoren und Bewertungen sollen prominent sichtbar sein; sekundäre Metriken können zusammengeklappt oder nachrangig dargestellt werden.
- Darstellungsrisiken: zu viele gleichwertige Elemente auf einer Ebene, fehlende visuelle Hierarchie, widersprüchliche Farb- oder Status-Signale.
- Bindungsrisiken: wenn Komponenten auf veraltete oder nicht-existente Backend-Felder verweisen.
- Prioritätsreihenfolge im UI: Kritische Warnungen → Aktionen → Marktdaten → Historisches.
`.trim();

/* ─────────────────────────────────────────────
   System prompt
   ───────────────────────────────────────────── */

const SYSTEM_PROMPT = `
Du bist Gemini Architect V1 – der dedizierte Frontend-Architekt und Präsentationsassistent für das HQS-System.

${HQS_FRONTEND_CONTEXT}

Deine Aufgabe:
- Frontend-/Layout-/Darstellungsfragen sachlich und strukturiert beantworten.
- Konkrete Empfehlungen für Aufbau, Hierarchie und Darstellungsklarheit geben.
- Risiken in Bindings, Views und Darstellungslogik erkennen und benennen.
- Ruhig, präzise und verständlich formulieren.

Deine Rolle ist NICHT:
- Backend-Diagnose oder Code-Fehlersuche im Backend.
- News-Zusammenfassung oder allgemeiner Chat.
- Duplizierung der DeepSeek-Diagnose- oder Change-Intelligence-Funktionen.

Regeln:
1. Antworte immer auf Deutsch. Nutze einfache, klare Sprache. Kurze Sätze bevorzugen.
2. Antworte NUR mit einem einzelnen gültigen JSON-Objekt – kein Markdown, keine Prosa, keine Erklärungen außerhalb des JSON.
3. JSON NICHT in Code-Fences einschließen.
4. Verwende genau diese Schlüssel auf oberster Ebene:
   - "summaryTitle"              (String – prägnanter Titel der Analyse)
   - "summaryText"               (String – ein bis drei Sätze Zusammenfassung)
   - "severity"                  (String, einer von: "low", "medium", "high")
   - "uiFindings"                (Array von kurzen Strings – konkrete Beobachtungen zur Oberfläche)
   - "layoutRecommendations"     (Array von kurzen Strings – Layout-Empfehlungen)
   - "priorityRecommendations"   (Array von kurzen Strings – Priorisierungshinweise für das UI)
   - "frontendGuardNotes"        (Array von kurzen Strings – Binding- / View-Risiken)
   - "recommendedAction"         (String – die eine wichtigste Maßnahme)
   - "confidenceNote"            (String – kurzer Hinweis zur Verlässlichkeit dieser Einschätzung)
5. Jeder Array-Wert MUSS ein Array sein, niemals ein einzelner String.
6. Jeden Array-Eintrag kurz halten (maximal ein Satz).
7. "severity" muss den Gesamtschweregrad der Frontend-Risiken widerspiegeln:
   - "low"    → kleinere Auffälligkeiten, kein dringender Handlungsbedarf
   - "medium" → merkliche Darstellungs- oder Strukturprobleme, die untersucht werden sollten
   - "high"   → ernste UI-Risiken, die sofortige Aufmerksamkeit erfordern
8. Keine Marketing-Sprache, keine Füllwörter, keine Disclaimers.

Beispiel für eine korrekte Antwort (nur als Format-Referenz):
{
  "summaryTitle": "Fehlende visuelle Hierarchie im Portfolio-Depot",
  "summaryText": "Die Depot-Ansicht zeigt Daten ohne klare Priorisierung. Kritische Status-Indikatoren sind nicht prominent genug dargestellt.",
  "severity": "medium",
  "uiFindings": [
    "PnL-Werte und Konviktionsstufen befinden sich auf gleicher Hierarchieebene.",
    "Fehlende Leerstandssignale bei nicht belegten Portfolio-Slots."
  ],
  "layoutRecommendations": [
    "Kritische Warnungen und Aktionen in einem hervorgehobenen Bereich oben platzieren.",
    "Sekundäre Metriken einklappbar gestalten."
  ],
  "priorityRecommendations": [
    "Risikowarnungen immer vor allgemeinen Marktdaten anzeigen."
  ],
  "frontendGuardNotes": [
    "PositionCard bindet an 'riskScore' – Feld muss im Symbol-Summary-Response vorhanden sein."
  ],
  "recommendedAction": "Depot-Layout in zwei Zonen aufteilen: oben Aktionen/Warnungen, unten Marktdaten.",
  "confidenceNote": "Einschätzung basiert auf beschriebener Struktur ohne direkten View-Zugriff."
}
`.trim();

/* ─────────────────────────────────────────────
   Structured output schema
   ───────────────────────────────────────────── */

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summaryTitle: { type: "string" },
    summaryText: { type: "string" },
    severity: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
    uiFindings: {
      type: "array",
      items: { type: "string" },
    },
    layoutRecommendations: {
      type: "array",
      items: { type: "string" },
    },
    priorityRecommendations: {
      type: "array",
      items: { type: "string" },
    },
    frontendGuardNotes: {
      type: "array",
      items: { type: "string" },
    },
    recommendedAction: { type: "string" },
    confidenceNote: { type: "string" },
  },
  required: [
    "summaryTitle",
    "summaryText",
    "severity",
    "uiFindings",
    "layoutRecommendations",
    "priorityRecommendations",
    "frontendGuardNotes",
    "recommendedAction",
    "confidenceNote",
  ],
};

/* ─────────────────────────────────────────────
   Mode-specific prompt additions
   ───────────────────────────────────────────── */

const MODE_INSTRUCTIONS = {
  layout_review: `
Prüfschwerpunkt: LAYOUT-REVIEW
Frage: Ist die Oberfläche strukturell sinnvoll aufgebaut?
Fokus: visuelle Hierarchie, räumliche Gruppierung zusammengehöriger Elemente, Informationsdichte, Abstände und Strukturklarheit.
Nicht im Fokus: Binding-Risiken, Backend-Felder, Prioritätsreihenfolge von Warnungen.
Ergebnisschwerpunkt: Layout-Probleme primär in "layoutRecommendations" und "uiFindings" eintragen.
`.trim(),

  presentation_review: `
Prüfschwerpunkt: DARSTELLUNGS-REVIEW
Frage: Ist die Darstellung verständlich, ruhig und konsistent kommuniziert?
Fokus: Lesbarkeit von Texten und Zahlen, Farbsignale und Status-Klarheit, Konsistenz von Darstellungsmustern, Nutzerkommunikation und Tonalität der Oberfläche.
Nicht im Fokus: strukturelle Layout-Fragen, Binding-Risiken, Backend-Felder.
Ergebnisschwerpunkt: Darstellungsprobleme primär in "uiFindings" und "layoutRecommendations" eintragen.
`.trim(),

  frontend_guard: `
Prüfschwerpunkt: FRONTEND-GUARD
Frage: Gibt es konkrete Binding-, View- oder Datenrisiken in der Frontend-Implementierung?
Fokus: Komponenten-Bindings an Backend-Felder (existieren diese Felder tatsächlich?), veraltete oder falsche Schema-Abhängigkeiten, fehlende Null-/Leer-Zustände, fehlerhafte Darstellung von Risiken oder Status.
Nicht im Fokus: allgemeine Layout-Fragen, Darstellungsästhetik, Prioritätsreihenfolge.
Wenn konkrete Binding- oder Schema-Brüche erkannt werden, muss "severity" mindestens "high" sein.
Ergebnisschwerpunkt: Binding- und Datenrisiken primär in "frontendGuardNotes" eintragen.
`.trim(),

  priority_review: `
Prüfschwerpunkt: PRIORITÄTS-REVIEW
Frage: Zeigt das UI gerade die richtigen Informationen an der richtigen Stelle prominent an?
Fokus: ob kritische Warnungen und Handlungsempfehlungen an oberster Stelle sichtbar sind, ob sekundäre oder historische Informationen die Hauptaussage verdrängen, ob die Informationshierarchie der Dringlichkeit entspricht.
Nicht im Fokus: Binding-Risiken, visuelle Designfragen, Backend-Felder.
Ergebnisschwerpunkt: Prioritätsprobleme primär in "priorityRecommendations" und "uiFindings" eintragen.
`.trim(),
};

/* ─────────────────────────────────────────────
   Input normalisation helpers
   ───────────────────────────────────────────── */

const MIN_ARRAY_ENTRY_LEN = 4;   // entries ≤ 3 chars are typically punctuation fragments or parsing artefacts
const MAX_ARRAY_ENTRIES   = 10;  // cap per array to avoid model data-dumps

function toStr(value) {
  if (value == null) return "";
  return String(value).trim();
}

function toStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

function normaliseMode(value) {
  const s = toStr(value).toLowerCase();
  return VALID_MODES.includes(s) ? s : DEFAULT_MODE;
}

function normaliseBridgeContext(value) {
  if (!value || typeof value !== "object") return null;
  return value;
}

function normaliseLayoutState(value) {
  if (!value) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch (_) {
      return "";
    }
  }
  return toStr(value);
}

/* ─────────────────────────────────────────────
   JSON response parsing & normalisation
   ───────────────────────────────────────────── */

function stripCodeFences(raw) {
  if (typeof raw !== "string") return String(raw || "");
  let text = raw.trim();
  let prev;
  do {
    prev = text;
    text = text
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
  } while (text !== prev);
  return text;
}

/**
 * Extract the first balanced JSON object {...} from arbitrary text.
 * Handles quoted braces inside strings.
 */
function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function fallbackResult(reason) {
  return {
    summaryTitle: "Analyse konnte nicht verarbeitet werden",
    summaryText: `Die Antwort konnte nicht sauber verarbeitet werden – ${reason || "unbekannte Ursache"}.`,
    severity: "medium",
    uiFindings: [],
    layoutRecommendations: [],
    priorityRecommendations: [],
    frontendGuardNotes: [],
    recommendedAction: "Bitte die Analyse erneut ausführen oder die Eingabe prüfen.",
    confidenceNote: "Keine Einschätzung möglich – Verarbeitungsfehler.",
  };
}

const EXPECTED_ARRAY_KEYS = [
  "uiFindings",
  "layoutRecommendations",
  "priorityRecommendations",
  "frontendGuardNotes",
];

const VALID_SEVERITIES = ["low", "medium", "high"];

/* ─────────────────────────────────────────────
   Severity guard – light, transparent rule base
   ─────────────────────────────────────────────
   Only raises severity, never lowers it.

   Tier 1 – Binding / schema / field breaks → severity must be at least "high"
   Tier 2 – Data-display / status-correctness risks → severity must be at least "medium"
   ───────────────────────────────────────────── */

const BINDING_BREAK_SIGNALS = [
  "binding",
  "schema-bruch",
  "schema bruch",
  "veraltetes feld",
  "veraltete felder",
  "falsches feld",
  "falsche felder",
  "fehlendes feld",
  "fehlende felder",
  "nicht vorhanden",
  "nicht existiert",
  "field missing",
];

const DATA_DISPLAY_RISK_SIGNALS = [
  "widersprüchlich",
  "irreführend",
  "falscher status",
  "falsches risiko",
  "falsche darstellung",
  "falsche anzeige",
  "risiko falsch",
  "inkonsistent",
];

function collectResultText(result) {
  const parts = [];
  if (result.summaryText) parts.push(result.summaryText);
  if (result.recommendedAction) parts.push(result.recommendedAction);
  for (const key of EXPECTED_ARRAY_KEYS) {
    const arr = result[key];
    if (Array.isArray(arr)) parts.push(...arr);
  }
  return parts.join(" ").toLowerCase();
}

const SEVERITY_ORDER = { low: 0, medium: 1, high: 2 };

function raiseSeverity(current, target) {
  // Guard: if either value is not a recognised severity, keep current
  if (!(current in SEVERITY_ORDER) || !(target in SEVERITY_ORDER)) return current;
  return SEVERITY_ORDER[target] > SEVERITY_ORDER[current] ? target : current;
}

function applySeverityGuard(result, mode) {
  const text = collectResultText(result);
  let targetSeverity = result.severity;

  // Tier 1: binding / schema breaks → at least "high"
  if (BINDING_BREAK_SIGNALS.some((sig) => text.includes(sig))) {
    targetSeverity = raiseSeverity(targetSeverity, "high");
  }

  // Tier 2: data-display / status-correctness risks → at least "medium"
  // Short-circuit: if Tier 1 already forced "high", Tier 2 is irrelevant.
  if (targetSeverity !== "high" && DATA_DISPLAY_RISK_SIGNALS.some((sig) => text.includes(sig))) {
    targetSeverity = raiseSeverity(targetSeverity, "medium");
  }

  if (targetSeverity !== result.severity) {
    logger.info("[geminiArchitect] severity raised by guard", {
      mode,
      from: result.severity,
      to: targetSeverity,
    });
    return { ...result, severity: targetSeverity };
  }

  return result;
}

/* ─────────────────────────────────────────────
   Result normalisation helpers
   ───────────────────────────────────────────── */

function deduplicateEntries(arr) {
  const seen = new Set();
  return arr.filter((entry) => {
    const key = entry.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normaliseArrayField(value) {
  return deduplicateEntries(
    toStringArray(value)
      .filter((entry) => entry.length >= MIN_ARRAY_ENTRY_LEN)
      .slice(0, MAX_ARRAY_ENTRIES)
  );
}

function normaliseResult(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return fallbackResult("response was not an object");
  }

  const summaryText = toStr(obj.summaryText);
  const recommendedAction = toStr(obj.recommendedAction);
  const confidenceNote = toStr(obj.confidenceNote);

  const result = {
    summaryTitle: toStr(obj.summaryTitle) || "Gemini Architect Analyse",
    // summaryText, recommendedAction, confidenceNote: fall back to a neutral German placeholder
    // when the model returns an empty or near-empty value, so consumers never receive bare empty strings.
    summaryText:
      summaryText.length >= MIN_ARRAY_ENTRY_LEN
        ? summaryText
        : "Keine Zusammenfassung verfügbar.",
    severity: "medium",
    uiFindings: [],
    layoutRecommendations: [],
    priorityRecommendations: [],
    frontendGuardNotes: [],
    recommendedAction:
      recommendedAction.length >= MIN_ARRAY_ENTRY_LEN
        ? recommendedAction
        : "Analyse erneut mit spezifischerer Eingabe ausführen.",
    confidenceNote:
      confidenceNote.length >= MIN_ARRAY_ENTRY_LEN
        ? confidenceNote
        : "Einschätzungsgrundlage nicht vollständig angegeben.",
  };

  const rawSeverity = toStr(obj.severity).toLowerCase();
  result.severity = VALID_SEVERITIES.includes(rawSeverity) ? rawSeverity : "medium";

  for (const key of EXPECTED_ARRAY_KEYS) {
    result[key] = normaliseArrayField(obj[key]);
  }

  return result;
}

/* ─────────────────────────────────────────────
   User prompt builder
   ───────────────────────────────────────────── */

function buildUserPrompt(normalised) {
  const {
    mode,
    message,
    context,
    notes,
    affectedAreas,
    affectedViews,
    affectedComponents,
    bridgeContext,
    frontendObservations,
    priorityContext,
    layoutState,
  } = normalised;

  const sections = [];

  const modeInstruction = MODE_INSTRUCTIONS[mode];
  if (modeInstruction) {
    sections.push(modeInstruction);
  }

  // ── Workflow context: inject orchestration metadata from bridge ──
  if (bridgeContext && bridgeContext.workflow) {
    const wf = bridgeContext.workflow;
    const wfParts = [];
    if (wf.reviewIntent) {
      wfParts.push(`Prüfintent: ${wf.reviewIntent}`);
    }
    if (wf.inspectionFocus) {
      const focus = wf.inspectionFocus;
      if (focus.category) wfParts.push(`Schwerpunkt-Kategorie: ${focus.category}`);
      if (focus.needsFollowup) wfParts.push("Folgeprüfung: ja");
      if (focus.affectedViews && focus.affectedViews.length) {
        wfParts.push(`Betroffene Bereiche: ${focus.affectedViews.join(", ")}`);
      }
      if (focus.affectedFields && focus.affectedFields.length) {
        wfParts.push(`Betroffene Felder: ${focus.affectedFields.join(", ")}`);
      }
      // Step 3: include suggested follow-up types and affected layers
      if (focus.suggestedFollowupTypes && focus.suggestedFollowupTypes.length) {
        wfParts.push(`Empfohlene Folgeprüfungen: ${focus.suggestedFollowupTypes.map(f => f.replace(/_/g, " ")).join(", ")}`);
      }
      if (focus.likelyAffectedLayers && focus.likelyAffectedLayers.length) {
        wfParts.push(`Wahrscheinlich betroffene Schichten: ${focus.likelyAffectedLayers.map(l => l.replace(/_/g, " ")).join(", ")}`);
      }
    }
    if (wf.sourceAgent) wfParts.push(`Quelle: ${wf.sourceAgent}`);
    if (wf.sourceMode) wfParts.push(`Quell-Modus: ${wf.sourceMode}`);
    if (wfParts.length) {
      sections.push(`Workflow-Kontext (automatisch abgeleitet):\n${wfParts.map((p) => `- ${p}`).join("\n")}`);
    }
  }

  // ── Step 3: Inject impact translation context ──
  if (bridgeContext && bridgeContext.impactTranslation) {
    const it = bridgeContext.impactTranslation;
    const itParts = [];
    if (it.impactSummary && it.impactKind !== "none") {
      itParts.push(`Wirkungszusammenfassung: ${it.impactSummary}`);
    }
    if (it.impactKind && it.impactKind !== "none") {
      itParts.push(`Art der Auswirkung: ${it.impactKind.replace(/_/g, " ")}`);
    }
    if (it.likelyAffectedLayers && it.likelyAffectedLayers.length) {
      itParts.push(`Wahrscheinlich betroffene Schichten: ${it.likelyAffectedLayers.map(l => l.replace(/_/g, " ")).join(", ")}`);
    }
    if (it.affectedArtifactHints && it.affectedArtifactHints.length) {
      itParts.push(`Möglicherweise betroffene Artefakte: ${it.affectedArtifactHints.join(", ")}`);
    }
    if (itParts.length) {
      sections.push(`Kooperative Wirkungseinschätzung (Backend → Frontend):\n${itParts.map((p) => `- ${p}`).join("\n")}`);
    }
  }

  // ── Step 6: Inject action readiness context ──
  if (bridgeContext && bridgeContext.patternContext) {
    const pc = bridgeContext.patternContext;
    const arParts = [];
    if (pc.actionReadinessBand) {
      const readinessLabels = {
        observation:                "Beobachtung – noch kein konkreter Handlungsbedarf",
        further_check_recommended:  "Weitere Prüfung sinnvoll",
        useful_next_step:           "Brauchbarer nächster Schritt erkannt",
        mature_recommendation:      "Reifere Empfehlung – stärkere Evidenz vorhanden",
      };
      arParts.push(`Handlungsreife: ${readinessLabels[pc.actionReadinessBand] || pc.actionReadinessBand}`);
    }
    if (pc.recommendedActionType && pc.recommendedActionType !== "observe") {
      const actionLabels = {
        check_ui:               "UI prüfen",
        check_binding:          "Binding prüfen",
        check_layout:           "Layout prüfen",
        re_evaluate_priority:   "Priorität neu bewerten",
        run_followup:           "Folgeprüfung erneut ausführen",
        prepare_change:         "Änderung vorbereiten",
      };
      arParts.push(`Empfohlene nächste Prüfung: ${actionLabels[pc.recommendedActionType] || pc.recommendedActionType}`);
    }
    if (pc.readinessReason) {
      arParts.push(`Begründung: ${pc.readinessReason}`);
    }
    if (arParts.length) {
      sections.push(`Handlungsreife-Einschätzung (Entscheidungshilfe, keine Ausführung):\n${arParts.map((p) => `- ${p}`).join("\n")}`);
    }
  }

  // ── Step 7: Inject recommendation improvement context ──
  if (bridgeContext && bridgeContext.improvementContext) {
    const ic = bridgeContext.improvementContext;
    const impParts = [];
    if (ic.dominantFeedback) {
      const feedbackLabels = {
        helpful:               "Empfehlung war hilfreich",
        usable:                "brauchbare Richtung",
        too_early:             "zu frühes Signal",
        unclear:               "unklare Empfehlung",
        not_needed:            "nicht nötig",
        followup_was_better:   "Folgeprüfung war sinnvoller",
      };
      impParts.push(`Bisherige Rückmeldung: ${feedbackLabels[ic.dominantFeedback] || ic.dominantFeedback}`);
    }
    if (ic.dominantImprovement && ic.dominantImprovement !== "none") {
      const improvementLabels = {
        needs_more_context:    "mehr Kontext wäre hilfreich",
        too_generic:           "Empfehlung war zu allgemein",
        timing_off:            "Zeitpunkt war unpassend",
        wrong_layer:           "falsche Schicht adressiert",
        followup_preferred:    "Folgeprüfung wäre sinnvoller gewesen",
      };
      impParts.push(`Verbesserungssignal: ${improvementLabels[ic.dominantImprovement] || ic.dominantImprovement}`);
    }
    if (ic.feedbackCount) {
      impParts.push(`Rückmeldungen zu diesem Muster: ${ic.feedbackCount}`);
    }
    if (impParts.length) {
      sections.push(`Rückkopplung aus bisherigen Empfehlungen (Verbesserungssignal, keine Bewertung):\n${impParts.map((p) => `- ${p}`).join("\n")}`);
    }
  }

  // ── Step 8: Inject governance / policy context ──
  if (bridgeContext && bridgeContext.governanceContext) {
    const gc = bridgeContext.governanceContext;
    const govParts = [];
    if (gc.policyClass) {
      const policyLabels = {
        shadow_only:         "Nur interne Shadow-Beobachtung",
        internal_only:       "Nur interne Sichtbarkeit",
        needs_more_evidence: "Benötigt mehr Evidenz vor Freigabe",
        admin_visible:       "Admin-sichtbar",
        guardian_candidate:  "Guardian-Kandidat (keine Auto-Freigabe)",
      };
      govParts.push(`Policy-Klasse: ${policyLabels[gc.policyClass] || gc.policyClass}`);
    }
    if (gc.guardianEligibility) {
      govParts.push("Guardian-Eignung: vorläufig gegeben (manuelle Prüfung erforderlich)");
    }
    if (gc.needsMoreEvidence) {
      govParts.push("Evidenzlage: noch nicht ausreichend für Freigabe");
    }
    if (gc.governanceReason) {
      govParts.push(`Begründung: ${gc.governanceReason}`);
    }
    if (govParts.length) {
      sections.push(`Governance-/Sichtbarkeitsklassifikation (nur Einordnung, keine Ausführung):\n${govParts.map((p) => `- ${p}`).join("\n")}`);
    }
  }

  // ── Step 10: Inject issue intelligence context ──
  if (bridgeContext && bridgeContext.issueContext) {
    const ic = bridgeContext.issueContext;
    const issueParts = [];
    if (ic.issueCategory) {
      issueParts.push(`Auffälligkeitskategorie: ${ic.issueCategory}`);
    }
    if (ic.affectedLayer) {
      issueParts.push(`Betroffene Schicht: ${ic.affectedLayer}`);
    }
    if (ic.issueSeverity) {
      issueParts.push(`Konservative Dringlichkeit: ${ic.issueSeverity}`);
    }
    if (ic.suspectedCause) {
      issueParts.push(`Vermutete Ursache: ${ic.suspectedCause}`);
    }
    if (ic.suggestedFix) {
      issueParts.push(`Empfohlene Prüfung: ${ic.suggestedFix}`);
    }
    if (ic.needsFollowup) {
      issueParts.push("Folgeprüfung: sinnvoll");
    }
    if (ic.issueReason) {
      issueParts.push(`Begründung: ${ic.issueReason}`);
    }
    if (issueParts.length) {
      sections.push(`Issue-Intelligence-Sicht (technische Auffälligkeit, keine Auto-Reparatur):\n${issueParts.map((p) => `- ${p}`).join("\n")}`);
    }
  }

  // ── Step 11: Inject case / resolution context ──
  if (bridgeContext && bridgeContext.caseContext) {
    const cc = bridgeContext.caseContext;
    const caseParts = [];
    if (cc.caseStatus) {
      caseParts.push(`Bearbeitungszustand: ${cc.caseStatus}`);
    }
    if (cc.caseOutcome && cc.caseOutcome !== "pending") {
      caseParts.push(`Fallergebnis: ${cc.caseOutcome}`);
    }
    if (cc.helpfulnessBand && cc.helpfulnessBand !== "too_early_to_tell") {
      caseParts.push(`Hilfseinschätzung: ${cc.helpfulnessBand}`);
    }
    if (cc.caseReason) {
      caseParts.push(`Begründung: ${cc.caseReason}`);
    }
    if (caseParts.length) {
      sections.push(`Fall-/Verlaufssicht (operativer Bearbeitungszustand, keine automatische Lösung):\n${caseParts.map((p) => `- ${p}`).join("\n")}`);
    }
  }

  // ── Step 12: Inject attention / priority context ──
  if (bridgeContext && bridgeContext.attentionContext) {
    const ac = bridgeContext.attentionContext;
    const attParts = [];
    if (ac.attentionBand) {
      attParts.push(`Aufmerksamkeitsstufe: ${ac.attentionBand}`);
    }
    if (ac.attentionReason) {
      attParts.push(`Begründung: ${ac.attentionReason}`);
    }
    if (ac.focusDrivers && ac.focusDrivers.length > 0) {
      attParts.push(`Fokustreiber: ${ac.focusDrivers.join(", ")}`);
    }
    if (attParts.length) {
      sections.push(`Aufmerksamkeits-/Fokussicht (operative Priorität, keine automatische Ausführung):\n${attParts.map((p) => `- ${p}`).join("\n")}`);
    }
  }

  if (message) {
    sections.push(`Anfrage:\n${message}`);
  }

  if (affectedAreas.length) {
    sections.push(
      `Betroffene Systembereiche:\n${affectedAreas.map((a) => `- ${a}`).join("\n")}`
    );
  }

  if (affectedViews.length) {
    sections.push(
      `Betroffene Views / Seiten:\n${affectedViews.map((v) => `- ${v}`).join("\n")}`
    );
  }

  if (affectedComponents.length) {
    sections.push(
      `Betroffene Komponenten:\n${affectedComponents.map((c) => `- ${c}`).join("\n")}`
    );
  }

  if (frontendObservations.length) {
    sections.push(
      `Frontend-Beobachtungen:\n${frontendObservations.map((o) => `- ${o}`).join("\n")}`
    );
  }

  if (layoutState) {
    sections.push(`Aktueller Layout-Zustand:\n${layoutState}`);
  }

  if (priorityContext) {
    sections.push(`Prioritätskontext:\n${priorityContext}`);
  }

  if (bridgeContext) {
    try {
      const bridgeStr = JSON.stringify(bridgeContext, null, 2);
      sections.push(`Agent-Bridge-Kontext:\n${bridgeStr}`);
    } catch (_) {
      // ignore malformed bridge context
    }
  }

  if (context) {
    sections.push(`Zusätzlicher Kontext:\n${context}`);
  }

  if (notes) {
    sections.push(`Hinweise:\n${notes}`);
  }

  return sections.join("\n\n");
}

/* ─────────────────────────────────────────────
   Raw response extraction
   ───────────────────────────────────────────── */

function getResponseText(response) {
  try {
    const geminiResponse = response?.response ?? response;
    if (!geminiResponse) return "";

    if (typeof geminiResponse.text === "function") {
      const value = geminiResponse.text();
      if (typeof value === "string") return value;
    }

    if (typeof geminiResponse.text === "string") {
      return geminiResponse.text;
    }

    if (Array.isArray(geminiResponse.candidates)) {
      const parts = geminiResponse.candidates
        .flatMap((candidate) => candidate?.content?.parts || [])
        .map((part) => part?.text || "")
        .filter(Boolean);

      if (parts.length) return parts.join("\n");
    }
  } catch (_) {
    // swallow and fall through
  }

  return "";
}

/* ─────────────────────────────────────────────
   Core review function
   ───────────────────────────────────────────── */

async function runGeminiArchitectReview(payload = {}) {
  if (!isGeminiConfigured()) {
    logger.warn("[geminiArchitect] GEMINI_API_KEY not configured – returning fallback");
    return {
      mode: normaliseMode(payload.mode),
      result: fallbackResult("GEMINI_API_KEY nicht konfiguriert"),
    };
  }

  const normalised = {
    mode: normaliseMode(payload.mode),
    message: toStr(payload.message),
    context: toStr(payload.context),
    notes: toStr(payload.notes),
    affectedAreas: toStringArray(payload.affectedAreas),
    affectedViews: toStringArray(payload.affectedViews),
    affectedComponents: toStringArray(payload.affectedComponents),
    bridgeContext: normaliseBridgeContext(payload.bridgeContext),
    frontendObservations: toStringArray(payload.frontendObservations),
    priorityContext: toStr(payload.priorityContext),
    layoutState: normaliseLayoutState(payload.layoutState),
  };

  const userPrompt = buildUserPrompt(normalised);

  if (!userPrompt.trim()) {
    return {
      mode: normalised.mode,
      result: fallbackResult("no input data provided"),
    };
  }

  const client = getGeminiClient();
  const modelName = getModelName();

  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  logger.info("[geminiArchitect] sending request", {
    mode: normalised.mode,
    model: modelName,
    hasMessage: Boolean(normalised.message),
    hasContext: Boolean(normalised.context),
    hasBridgeContext: Boolean(normalised.bridgeContext),
    bridgeReviewIntent: normalised.bridgeContext?.workflow?.reviewIntent || null,
    bridgeRecommendedMode: normalised.bridgeContext?.workflow?.recommendedGeminiMode || null,
    bridgeInspectionCategory: normalised.bridgeContext?.workflow?.inspectionFocus?.category || null,
    bridgeImpactKind: normalised.bridgeContext?.impactTranslation?.impactKind || null,
    bridgeSuggestedFollowups: normalised.bridgeContext?.impactTranslation?.suggestedFollowupTypes || [],
    // Step 6: action readiness context
    bridgeActionReadiness: normalised.bridgeContext?.patternContext?.actionReadinessBand || null,
    bridgeRecommendedAction: normalised.bridgeContext?.patternContext?.recommendedActionType || null,
    // Step 7: recommendation improvement context
    bridgeDominantFeedback: normalised.bridgeContext?.improvementContext?.dominantFeedback || null,
    bridgeDominantImprovement: normalised.bridgeContext?.improvementContext?.dominantImprovement || null,
    // Step 10: issue intelligence context
    bridgeIssueCategory: normalised.bridgeContext?.issueContext?.issueCategory || null,
    bridgeIssueLayer: normalised.bridgeContext?.issueContext?.affectedLayer || null,
    bridgeIssueSeverity: normalised.bridgeContext?.issueContext?.issueSeverity || null,
    // Step 11: case / resolution context
    bridgeCaseStatus: normalised.bridgeContext?.caseContext?.caseStatus || null,
    bridgeCaseOutcome: normalised.bridgeContext?.caseContext?.caseOutcome || null,
    bridgeHelpfulnessBand: normalised.bridgeContext?.caseContext?.helpfulnessBand || null,
  });

  let response;
  try {
    response = await model.generateContent(userPrompt);
  } catch (apiErr) {
    logger.warn("[geminiArchitect] Gemini API call failed – using fallback", {
      mode: normalised.mode,
      model: modelName,
      reason: apiErr.message,
    });
    const safeMsg = String(apiErr.message || "").slice(0, 80);
    return {
      mode: normalised.mode,
      result: fallbackResult(`API-Fehler: ${safeMsg}`),
    };
  }

  const rawContent = getResponseText(response);

  const cleaned = stripCodeFences(rawContent);

  let parsed = null;
  let parseMethod = "direct";

  try {
    parsed = JSON.parse(cleaned);
  } catch (_firstErr) {
    parseMethod = "extraction";
    const extracted = extractJsonObject(cleaned) || extractJsonObject(rawContent);

    if (extracted) {
      try {
        parsed = JSON.parse(extracted);
      } catch (err) {
        logger.warn("[geminiArchitect] JSON parse failed after extraction – using fallback", {
          mode: normalised.mode,
          reason: err.message,
          rawPreview: String(rawContent).slice(0, 120),
        });

        return {
          mode: normalised.mode,
          result: fallbackResult("JSON parse error"),
        };
      }
    } else {
      logger.warn("[geminiArchitect] No JSON object found in response – using fallback", {
        mode: normalised.mode,
        rawPreview: String(rawContent).slice(0, 120),
      });

      return {
        mode: normalised.mode,
        result: fallbackResult("kein JSON-Objekt in Antwort gefunden"),
      };
    }
  }

  logger.info("[geminiArchitect] response parsed", { mode: normalised.mode, parseMethod });

  const normalisedResult = normaliseResult(parsed);
  const result = applySeverityGuard(normalisedResult, normalised.mode);

  logger.info("[geminiArchitect] review complete (cause → effect → follow-up)", {
    mode: normalised.mode,
    severity: result.severity,
    uiFindingsCount: result.uiFindings.length,
    guardNotesCount: result.frontendGuardNotes.length,
    parseMethod,
    bridgeReviewIntent: normalised.bridgeContext?.workflow?.reviewIntent || null,
    bridgeImpactKind: normalised.bridgeContext?.impactTranslation?.impactKind || null,
    workflowStage: "gemini_complete",
  });

  return {
    mode: normalised.mode,
    result,
  };
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */

module.exports = {
  isGeminiConfigured,
  runGeminiArchitectReview,
  VALID_MODES,
};
