"use strict";

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

async function generateBriefingText({ userName, symbols, facts }) {
  const prompt = `
Du bist ein freundlicher Assistent für ein Portfolio-Dashboard.

WICHTIG:
- Sehr einfache Sprache.
- Kurze Sätze.
- Keine Fachwörter. Wenn nötig: sofort kurz erklären.
- Keine Kauf- oder Verkaufsempfehlungen.
- Nutze nur die Fakten unten. Nichts erfinden.

NUTZER: ${userName || "Nutzer"}
SYMBOL-LISTE: ${symbols.join(", ")}

FAKTEN:
${facts}

Gib die Antwort exakt so:

TITEL: <kurzer Titel>

KURZ:
- <1 Satz>

GESTERN:
- <max 3 Punkte>

NÄCHSTE TAGE:
- <max 3 Punkte>

WAS BEDEUTET DAS FÜR DICH?
- <max 3 kurze Sätze>
`.trim();

  const resp = await getClient().chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.4,
    max_tokens: 700,
    messages: [
      { role: "system", content: "Du schreibst extrem leicht verständlich." },
      { role: "user", content: prompt },
    ],
  });

  const text = resp?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned empty text");

  return text;
}

module.exports = { generateBriefingText };
