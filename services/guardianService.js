const { GoogleGenerativeAI } = require("@google/generative-ai");

// Gemini Init
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

/**
 * Interpretiert HQS Score in Risikostufe
 */
function calculateRiskLevel(hqsScore) {
  const score = Number(hqsScore || 0);

  if (score >= 75) return "Low Risk";
  if (score >= 55) return "Moderate Risk";
  return "High Risk";
}

/**
 * Opportunity Level
 */
function calculateOpportunityLevel(hqsScore, marketPhase) {
  const score = Number(hqsScore || 0);

  if (marketPhase === "bull" && score >= 65) return "High Opportunity";
  if (marketPhase === "neutral" && score >= 60) return "Watchlist Opportunity";
  return "Limited Opportunity";
}

/**
 * Hauptfunktion Guardian
 * Erwartet bereits berechnete HQS-Daten
 */
async function analyzeStockWithGuardian(stockData = {}) {
  try {
    if (!stockData.symbol) {
      throw new Error("Guardian benötigt vollständige HQS-Daten.");
    }

    const {
      symbol,
      hqsScore,
      marketPhase,
      currentScore,
      stabilityScore,
      decision
    } = stockData;

    const riskLevel = calculateRiskLevel(hqsScore);
    const opportunityLevel = calculateOpportunityLevel(hqsScore, marketPhase);

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
    Du bist ein quantitativer Investment-Assistent.

    Aktie: ${symbol}
    HQS Score: ${hqsScore}
    Current Score: ${currentScore}
    Stability Score: ${stabilityScore}
    Marktphase: ${marketPhase}
    Entscheidung: ${decision}
    Risiko-Level: ${riskLevel}
    Opportunity-Level: ${opportunityLevel}

    Gib eine kurze professionelle Einschätzung (max. 4 Sätze).
    Kein Disclaimer.
    Kein Marketing.
    Fokus auf Risiko + Momentum.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    return {
      symbol,
      hqsScore,
      marketPhase,
      decision,
      riskLevel,
      opportunityLevel,
      guardianInsight: response.text()
    };

  } catch (error) {
    console.error("Guardian Service Fehler:", error.message);
    throw new Error("Guardian Analyse fehlgeschlagen.");
  }
}

module.exports = { analyzeStockWithGuardian };
