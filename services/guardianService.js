const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

async function analyzeStockWithGuardian(ticker) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-pro"   // ✅ Cloud v1 kompatibel
    });

    const prompt = `
    Analysiere die aktuelle Marktsituation für die Aktie ${ticker}.
    Gib:
    - Kurze Marktanalyse
    - Aktuelles Sentiment
    - Risiko-Einschätzung
    - Handlungsempfehlung
    `;

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ]
    });

    const response = await result.response;
    return response.text();

  } catch (error) {
    console.error("Guardian Service Fehler:", error);
    throw new Error("Gemini Analyse fehlgeschlagen.");
  }
}

module.exports = { analyzeStockWithGuardian };
