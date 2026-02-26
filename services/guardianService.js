const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function analyzeStockWithGuardian(context) {
  const {
    symbol,
    segment,
    provider,
    fallbackUsed,
    marketData,
  } = context;

  const prompt = `
Du bist Guardian AI – ein professionelles Finanz-Analyse-System.

Analysiere folgende Marktdaten:

Symbol: ${symbol}
Segment: ${segment}
Provider: ${provider}
Fallback verwendet: ${fallbackUsed ? "Ja" : "Nein"}

Marktdaten:
${JSON.stringify(marketData, null, 2)}

Erstelle eine strukturierte Analyse mit:

1. Bewertung: Bullish / Neutral / Bearish
2. Risiko-Level: Niedrig / Mittel / Hoch
3. Kurze Begründung (3-5 Sätze)
4. Handlungsempfehlung
`;

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  return response.choices[0].message.content;
}

module.exports = { analyzeStockWithGuardian };
