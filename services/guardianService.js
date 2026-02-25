const { GoogleGenerativeAI } = require("@google/generative-ai");

// API Key sauber laden
const apiKey = (process.env.GOOGLE_GEMINI_API_KEY || "").trim();

if (!apiKey) {
  console.error("❌ GOOGLE_GEMINI_API_KEY ist nicht gesetzt!");
}

const genAI = new GoogleGenerativeAI(apiKey);

async function analyzeStockWithGuardian(ticker) {
  try {
    console.log("🔎 Starte Gemini Analyse für:", ticker);

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-latest"
    });

    const prompt = `
    Analysiere die aktuelle Marktsituation für die Aktie ${ticker}.
    Gib:
    - Markt-Sentiment (Bullisch / Neutral / Bärisch)
    - Kurzfristiges Risiko (Niedrig / Mittel / Hoch)
    - Eine kurze strategische Einschätzung in 3–5 Sätzen.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    console.log("✅ Gemini Analyse erfolgreich");

    return text;

  } catch (error) {
    console.error("❌ Gemini Fehler:", error?.message || error);
    throw new Error(error?.message || "Gemini Analyse fehlgeschlagen.");
  }
}

module.exports = {
  analyzeStockWithGuardian
};
