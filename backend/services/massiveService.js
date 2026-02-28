// backend/services/massiveService.js

const fetch = require("node-fetch");

async function getDividends(ticker) {
  try {
    const response = await fetch(
      `https://api.massive.com/v3/reference/dividends?ticker=${ticker}&limit=100`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MASSIVE_API_KEY}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Massive API Error: ${response.status}`);
    }

    const data = await response.json();

    return data.results || [];
  } catch (error) {
    console.error("Dividend Fetch Error:", error.message);
    return [];
  }
}

module.exports = { getDividends };
