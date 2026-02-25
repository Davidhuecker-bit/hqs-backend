const axios = require("axios");

const API_KEY = (process.env.GOOGLE_GEMINI_API_KEY || "").trim();

async function analyzeStockWithGuardian(ticker) {
  try {
    if (!API_KEY) {
      return "❌ API KEY FEHLT IN RAILWAY";
    }

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: `Analysiere die Aktie ${ticker} und gib eine kurze Einschätzung.`
              }
            ]
          }
        ]
      }
    );

    return response.data.candidates[0].content.parts[0].text;

  } catch (error) {
    console.error("ECHTER GEMINI FEHLER:", error.response?.data || error.message);

    return {
      error: true,
      details: error.response?.data || error.message
    };
  }
}

module.exports = { analyzeStockWithGuardian };
