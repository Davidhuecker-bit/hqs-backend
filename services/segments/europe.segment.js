async function getEuropeData(symbol) {
  try {
    const data = await fmp.getQuote(symbol);
    return { success: true, source: "fmp", data };
  } catch {
    return {
      success: false,
      error: "Europe provider failed",
      data: null,
    };
  }
}

module.exports = { getEuropeData };
