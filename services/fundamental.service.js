// services/fundamental.service.js
// HQS Fundamental Data Service
// Holt Income Statements (5 Jahre) von FMP

const axios = require("axios");

const FMP_API_KEY = process.env.FMP_API_KEY;
const BASE_URL = "https://financialmodelingprep.com/api/v3";

async function getFundamentals(symbol) {
  try {
    const response = await axios.get(
      `${BASE_URL}/income-statement/${symbol}?limit=5&apikey=${FMP_API_KEY}`
    );

    const data = response.data;

    if (!data || data.length === 0) {
      return null;
    }

    return data.map(year => ({
      year: year.calendarYear,
      revenue: year.revenue,
      netIncome: year.netIncome,
      ebitda: year.ebitda,
      eps: year.eps,
      operatingIncome: year.operatingIncome,
    }));

  } catch (error) {
    console.error("Fundamental fetch error:", error.message);
    return null;
  }
}

module.exports = {
  getFundamentals,
};
