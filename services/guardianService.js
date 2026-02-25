const axios = require("axios");

const API_KEY = (process.env.GOOGLE_GEMINI_API_KEY || "").trim();

if (!API_KEY) {
  console.error("❌ GOOGLE_GEMINI_API_KEY fehlt!");
}

async function analyzeStockWithGuardian(ticker) {
  try {
    console.log("🔎 Starte neue Gemini v1 Analyse für:", ticker);

    const response = await axios.post(
      "https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=" + API_KEY,
      {
        contents: [
          {
            parts: [
              {
                text: `Analysiere die aktuelle Marktsituation für die Aktie ${ticker}.
Gib:
- Markt-Sentiment
- Kurzfristiges Risiko
- Strategische Einschätzung`
              }
            ]
          }
        ]
      }
    );

    const text =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Keine Antwort erhalten.";

    console.log("✅ Gemini v1 Analyse erfolgreich");

    return text;

  } catch (error) {
    console.error("❌ Gemini v1 Fehler:", error.response?.data || error.message);
    throw new Error("Gemini Analyse fehlgeschlagen.");
  }
}

module.exports = {
  analyzeStockWithGuardian
};
