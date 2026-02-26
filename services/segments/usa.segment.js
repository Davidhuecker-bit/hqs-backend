const provider = require("../providerService");

async function getUSData(symbol) {
  const timestamp = new Date().toISOString();

  try {
    const result = await provider.getUSQuote(symbol);

    return {
      success: true,
      segment: "usa",
      provider: result.provider,
      symbol,
      data: result.data,
      fallbackUsed: result.fallbackUsed,
      timestamp,
    };
  } catch (error) {
    return {
      success: false,
      segment: "usa",
      provider: null,
      symbol,
      data: null,
      fallbackUsed: false,
      error: error.message,
      timestamp,
    };
  }
}

module.exports = { getUSData };
