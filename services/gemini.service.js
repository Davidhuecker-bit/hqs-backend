"use strict";

const axios = require("axios");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Modell kannst du später anpassen
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash-001";

function buildPrompt({ userName, symbols, facts }) {
  // EXTREM einfache Sprache
  return `
Du bist ein freundlicher Assistent für ein Portfolio-Dashboard.
WICHTIG:
- Schreibe in sehr einfacher Sprache.
- Kurze Sätze.
- Keine Fachwörter. Wenn nötig: sofort kurz erklären.
- Keine Kauf- oder Verkaufsempfehlungen.
- Fokus: "Was bedeutet das für dich?"

NUTZER: ${userName || "Nutzer"}
WATCHLIST/PORTFOLIO-SYMBOLE: ${symbols.join(", ")}

FAKTEN (nur diese nutzen, nichts erfinden):
${facts}

Gib die Antwort exakt in diesem Format:

TITEL: <kurzer Titel>

KURZ (1 Satz):
- <1 Satz>

GESTERN (max 3 Punkte):
- <Punkt 1>
- <Punkt 2>
- <Punkt 3>

NÄCHSTE TAGE (max 3 Punkte):
- <Punkt 1>
- <Punkt 2>
- <Punkt 3>

WAS BEDEUTET DAS FÜR DICH? (max 3 kurze Sätze):
- <Satz 1>
- <Satz 2>
- <Satz 3>
`.trim();
}

async function generateBriefingText({ userName, symbols, facts }) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const prompt = buildPrompt({ userName, symbols, facts });

  const body = {
    contents: [
      { role: "user", parts: [{ text: prompt }] }
    ],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 600
    }
  };

  const res = await axios.post(url, body, { timeout: 20000 });

  const text =
    res?.data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ||
    null;

  if (!text) throw new Error("Gemini returned empty text");

  return text.trim();
}

module.exports = { generateBriefingText };
