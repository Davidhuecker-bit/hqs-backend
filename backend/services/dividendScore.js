function calculateDividendScore(dividendHistory) {
  if (!dividendHistory || dividendHistory.length < 5) {
    return 20;
  }

  const sorted = dividendHistory.sort(
    (a, b) => new Date(a.ex_dividend_date) - new Date(b.ex_dividend_date)
  );

  const latest = sorted[sorted.length - 1].cash_amount;
  const fiveYearsAgo = sorted[Math.max(0, sorted.length - 20)].cash_amount;

  if (!fiveYearsAgo || fiveYearsAgo === 0) return 30;

  const growthRate = (latest - fiveYearsAgo) / fiveYearsAgo;

  let growthScore = 40;
  if (growthRate > 0.1) growthScore = 100;
  else if (growthRate > 0.05) growthScore = 80;
  else if (growthRate > 0.01) growthScore = 60;
  else if (growthRate > 0) growthScore = 40;
  else growthScore = 10;

  let cuts = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].cash_amount < sorted[i - 1].cash_amount) {
      cuts++;
    }
  }

  let stabilityScore = 100;
  if (cuts === 1) stabilityScore = 70;
  else if (cuts <= 3) stabilityScore = 40;
  else if (cuts > 3) stabilityScore = 10;

  const years =
    (new Date(sorted[sorted.length - 1].ex_dividend_date) -
      new Date(sorted[0].ex_dividend_date)) /
    (1000 * 60 * 60 * 24 * 365);

  let historyScore = 20;
  if (years > 25) historyScore = 100;
  else if (years > 15) historyScore = 80;
  else if (years > 10) historyScore = 60;
  else if (years > 5) historyScore = 40;

  const avgPerYear = sorted.length / years;

  let consistencyScore = 40;
  if (avgPerYear >= 3.5) consistencyScore = 100;
  else if (avgPerYear >= 1.5) consistencyScore = 70;

  const finalScore =
    growthScore * 0.35 +
    stabilityScore * 0.25 +
    historyScore * 0.2 +
    consistencyScore * 0.2;

  return Math.round(finalScore);
}

module.exports = { calculateDividendScore };
