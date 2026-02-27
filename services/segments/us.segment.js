// services/segments/us.segment.js
// US Market Segment – Symbol Lists by Layer
// KEINE API Calls hier – nur Symbol-Definitionen

const US_SEGMENTS = {
  core: [
    "AAPL", "MSFT", "GOOGL", "AMZN", "META",
    "NVDA", "TSLA", "BRK.B", "JPM", "V",
  ],

  macro: [
    "SPY", "QQQ", "DIA", "IWM", "VTI",
    "TLT", "GLD", "SLV", "USO", "DXY",
  ],

  tech: [
    "NVDA", "AMD", "INTC", "QCOM", "AVGO",
    "ASML", "TSM", "MU", "AMAT", "LRCX",
  ],

  energy: [
    "XOM", "CVX", "COP", "SLB", "OXY",
    "PSX", "MPC", "VLO", "HAL", "BKR",
  ],

  finance: [
    "JPM", "BAC", "WFC", "GS", "MS",
    "C", "AXP", "BLK", "SCHW", "USB",
  ],

  health: [
    "JNJ", "PFE", "MRK", "ABBV", "LLY",
    "UNH", "CVS", "MDT", "BMY", "AMGN",
  ],

  consumer: [
    "AMZN", "HD", "MCD", "NKE", "SBUX",
    "TGT", "COST", "WMT", "LOW", "TJX",
  ],

  opportunity: [
    "PLTR", "RKLB", "IONQ", "SMCI", "ARM",
    "HOOD", "SOFI", "AFRM", "UPST", "PATH",
  ],
};

module.exports = { US_SEGMENTS };