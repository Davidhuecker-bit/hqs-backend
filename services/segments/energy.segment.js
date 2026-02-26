async function getEnergyData(symbol) {
  try {
    const data = await fmp.getCommodity(symbol);
    return { success: true, source: "fmp", data };
  } catch {
    return {
      success: false,
      error: "Energy provider failed",
      data: null,
    };
  }
}

module.exports = { getEnergyData };
