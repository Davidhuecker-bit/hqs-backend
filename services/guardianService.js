const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function analyzeStockWithGuardian(ticker) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // schnell & günstig
      messages: [
        {
          role: "system",
          content: "Du bist ein professioneller Finanzanalyst."
        },
        {
          role: "user",
          content: `
          Analysiere die aktuelle Marktsituation für die Aktie ${ticker}.
          Gib:
          - Kurze Marktanalyse
          - Aktuelles Sentiment
          - Risiko-Einschätzung
          - Handlungsempfehlung
          `
        }
      ],
      temperature: 0.4,
    });

    return completion.choices[0].message.content;

  } catch (error) {
    console.error("OpenAI Fehler:", error);
    throw new Error("OpenAI Analyse fehlgeschlagen.");
  }
}

module.exports = { analyzeStockWithGuardian };
