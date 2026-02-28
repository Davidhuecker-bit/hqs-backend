// backend/services/scoreEngine.js

const { getDividends } = require("./massiveService");
const { calculateDividendScore } = require("./dividendScore");

async function calculateFullScore(ticker) {
  try {
    const dividends = await getDividends(ticker);

    const dividendScore = calculateDividendScore(dividends);

    // Weitere Scores können hier ergänzt werden:
    // const fundamentalScore = ...
    // const riskScore = ...
    // const valuationScore = ...

    const totalScore =
      dividendScore * 0.15; // 15% Gewichtung im HQS

    return {
      totalScore: Math.round(totalScore),
      dividendScore,
    };
  } catch (error) {
    console.error("Score Engine Error:", error.message);

    return {
      totalScore: 0,
      dividendScore: 0,
    };
  }
}

module.exports = { calculateFullScore };
