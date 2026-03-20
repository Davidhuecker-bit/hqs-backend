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

  const prompt = `
Du bist Guardian AI – ein professionelles Finanz-Analyse-System.

Erkläre die folgenden finalen Marktdaten:

Symbol: ${symbol}

Marktdaten:
${JSON.stringify(marketData, null, 2)}

Erstelle eine strukturierte Erklärung mit:

1. Bewertung: Bullish / Neutral / Bearish
2. Risiko-Level: Niedrig / Mittel / Hoch
3. Kurze Begründung (3-5 Sätze)
4. Handlungsempfehlung
`;

  const response = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  return response.choices[0].message.content;
}

module.exports = { analyzeStockWithGuardian };
