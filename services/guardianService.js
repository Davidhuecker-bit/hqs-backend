const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialisierung mit deinem Key aus den Railway-Variablen
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

async function analyzeStockWithGuardian(ticker) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `Analysiere die aktuelle Marktsituation für die Aktie ${ticker}. 
    Gib eine kurze Einschätzung zu Sentiment und Risiko ab.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("Guardian Service Fehler:", error.message);
    throw new Error("KI-Analyse fehlgeschlagen.");
  }
}

module.exports = { analyzeStockWithGuardian };
