// services/fundamental.service.js

const axios = require("axios");

const FMP_API_KEY = process.env.FMP_API_KEY;

async function getFinancials(symbol) {
  try {
    const url = `https://financialmodelingprep.com/api/v3/income-statement/${symbol}?limit=5&apikey=${FMP_API_KEY}`;
    const response = await axios.get(url);

    if (!response.data || response.data.length === 0) {
      return null;
    }

    const incomeData = response.data;

    return incomeData.map(year => ({
      year: year.calendarYear,
      revenue: year.revenue,
      netIncome: year.netIncome,
      ebitda: year.ebitda,
      grossProfit: year.grossProfit,
    }));

  } catch (error) {
    console.error("Fundamental Fetch Error:", error.message);
    return null;
  }
}

module.exports = {
  getFinancials,
};
