const { GoogleGenerativeAI } = require("@google/generative-ai");

const key = (process.env.GOOGLE_GEMINI_API_KEY || "").trim();

function keyInfo() {
  if (!key) return { ok: false, reason: "MISSING" };
  return {
    ok: true,
    len: key.length,
    prefix: key.slice(0, 6) + "…" // nur Prefix, kein Leak
  };
}

const genAI = key ? new GoogleGenerativeAI(key) : null;

async function analyzeStockWithGuardian(ticker) {
  try {
    const info = keyInfo();
    console.log("🔑 Gemini Key Info:", info);

    if (!genAI) {
      throw new Error("GOOGLE_GEMINI_API_KEY fehlt oder ist leer.");
    }

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Analysiere die aktuelle Marktsituation für die Aktie ${ticker}.
Gib eine kurze Einschätzung zu Sentiment und Risiko ab.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    return response.text();
  } catch (error) {
    console.error("❌ Gemini ERROR RAW:", error);
    console.error("❌ Gemini ERROR MESSAGE:", error?.message);
    console.error("❌ Gemini ERROR STATUS:", error?.status || error?.code);

    throw new Error(error?.message || "Unbekannter Gemini Fehler");
  }
}

module.exports = { analyzeStockWithGuardian };
