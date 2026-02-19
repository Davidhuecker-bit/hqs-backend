const axios = require("axios");

const API_KEY = process.env.FMP_API_KEY;
const BASE_URL = "https://financialmodelingprep.com/stable";

async function fetchQuote(symbol) {
  if (!API_KEY) {
    throw new Error("FMP_API_KEY ist nicht gesetzt.");
  }

  const url = `${BASE_URL}/quote?symbol=${symbol}&apikey=${API_KEY}`;

  const response = await axios.get(url, { timeout: 8000 });

  if (!response.data || !Array.isArray(response.data)) {
    throw new Error("Ungültige FMP Antwort");
  }

  return response.data;
}

module.exports = {
  fetchQuote,
};
