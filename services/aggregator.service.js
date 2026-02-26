// services/aggregator.service.js

const { getUSData } = require("./segments/usa.segment");
const { getEuropeData } = require("./segments/europe.segment");
const { getEnergyData } = require("./segments/energy.segment");
const { getCryptoData } = require("./segments/crypto.segment");

async function getMarketDataBySegment({ segment, symbol }) {
  try {
    switch (segment) {
      case "usa":
        return await getUSData(symbol);

      case "europe":
        return await getEuropeData(symbol);

      case "energy":
        return await getEnergyData(symbol);

      case "crypto":
        return await getCryptoData(symbol);

      default:
        return {
          success: false,
          error: "Unknown segment",
          data: null,
        };
    }
  } catch (error) {
    console.error("Aggregator Error:", error.message);
    return {
      success: false,
      error: "Segment failed",
      data: null,
    };
  }
}

module.exports = {
  getMarketDataBySegment,
};
