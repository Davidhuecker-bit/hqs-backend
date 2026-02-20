// services/stability.service.js
// HQS Stability Score v1 (Intelligent)

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function calculateCAGR(current, past, years) {
  if (!past || past <= 0) return 0;
  return Math.pow(current / past, 1 / years) - 1;
}

function calculateVariance(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return (
    values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
    values.length
  );
}

function calculateStabilityScore(fundamentals) {
  if (!fundamentals || fundamentals.length < 3) return 50;

  const latest = fundamentals[0];
  const oldest = fundamentals[fundamentals.length - 1];
  const years = fundamentals.length - 1;

  // 1️⃣ Revenue CAGR
  const revenueCAGR = calculateCAGR(latest.revenue, oldest.revenue, years);

  // 2️⃣ Net Income CAGR
  const incomeCAGR = calculateCAGR(latest.netIncome, oldest.netIncome, years);

  // 3️⃣ EPS Stability (Varianz niedrig = gut)
  const epsValues = fundamentals.map(f => f.eps || 0);
  const epsVariance = calculateVariance(epsValues);

  // 4️⃣ Profit Margin (aktuell)
  const margin = latest.revenue
    ? latest.netIncome / latest.revenue
    : 0;

  let score = 50;

  // Wachstum
  if (revenueCAGR > 0.1) score += 10;
  if (incomeCAGR > 0.1) score += 15;

  // Stabilität
  if (epsVariance < 0.5) score += 10;
  if (epsVariance > 2) score -= 10;

  // Profitabilität
  if (margin > 0.2) score += 10;
  if (margin < 0.05) score -= 10;

  return clamp(score);
}

module.exports = {
  calculateStabilityScore,
};
