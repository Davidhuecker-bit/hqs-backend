function detectMarketRegime(trend, volatility) {
  if (trend > 0.1 && volatility < 0.25) return "Bullish";
  if (trend < -0.1 && volatility > 0.3) return "Bearish";
  return "Neutral";
}

module.exports = { detectMarketRegime };
