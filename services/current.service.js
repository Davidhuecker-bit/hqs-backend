// services/hqs/current.service.js
// HQS Current Score (Gegenwart) – v1.0
// Basis: Tagesänderung + Volumen-Spike + MarketCap (dein aktueller Ansatz)

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * calculateCurrentScore(item)
 * Erwartet Felder wie:
 * - changesPercentage
 * - volume
 * - avgVolume
 * - marketCap
 */
function calculateCurrentScore(item) {
  const change = Number(item?.changesPercentage ?? 0);
  const volume = Number(item?.volume ?? 0);
  const avgVolume = Number(item?.avgVolume ?? 1);

  const vRatio = avgVolume > 0 ? volume / avgVolume : 0;

  let score = 50;

  if (change > 0) score += 10;
  if (vRatio > 1.3) score += 15;
  if (item?.marketCap && Number(item.marketCap) > 1e11) score += 10;

  return clampScore(score);
}

function getCurrentInsight(currentScore) {
  if (currentScore >= 80) return "Starke institutionelle Akkumulation erkannt.";
  if (currentScore <= 45) return "Erhöhtes Risiko – Gewinnmitnahmen wahrscheinlich.";
  return "Neutraler Markt – Konsolidierungsphase möglich.";
}

module.exports = {
  calculateCurrentScore,
  getCurrentInsight,
};
