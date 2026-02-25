const { GoogleGenerativeAI } = require("@google/generative-ai");

if (!process.env.GOOGLE_GEMINI_API_KEY) {
  console.error("❌ GOOGLE_GEMINI_API_KEY ist NICHT gesetzt!");
}

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

async function analyzeStockWithGuardian(ticker) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
    Analysiere die aktuelle Marktsituation für die Aktie ${ticker}.
    Gib eine kurze Einschätzung zu Sentiment und Risiko ab.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    return response.text();

  } catch (error) {
    console.error("❌ Guardian Service Fehler DETAILS:");
    console.error(error);

    throw new Error(
      error?.message || "Unbekannter Gemini Fehler"
    );
  }
}

module.exports = { analyzeStockWithGuardian };
