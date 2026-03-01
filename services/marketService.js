// NUR der buildMarketSnapshot Bereich wird ersetzt

async function buildMarketSnapshot() {
  console.log("📦 Building market snapshot...");

  const changes = [];

  // Erst alle Daten sammeln
  const marketData = [];

  for (const symbol of WATCHLIST) {
    const raw = await fetchQuote(symbol);
    if (!raw || !raw.length) continue;

    const normalized = normalizeMarketData(raw[0], "massive", "us");
    if (!normalized) continue;

    marketData.push(normalized);
    changes.push(Number(normalized.changesPercentage) || 0);
  }

  const marketAverage =
    changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;

  for (const normalized of marketData) {
    try {
      await pool.query(
        `INSERT INTO market_snapshots 
        (symbol, price, open, high, low, volume, source, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [
          normalized.symbol,
          normalized.price,
          normalized.open,
          normalized.high,
          normalized.low,
          normalized.volume,
          normalized.source,
        ]
      );

      const hqs = await buildHQSResponse(normalized, marketAverage);

      await pool.query(
        `INSERT INTO hqs_scores
        (symbol, hqs_score, momentum, quality, stability, relative, regime, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [
          hqs.symbol,
          hqs.hqsScore,
          hqs.breakdown?.momentum ?? null,
          hqs.breakdown?.quality ?? null,
          hqs.breakdown?.stability ?? null,
          hqs.breakdown?.relative ?? null,
          hqs.regime ?? null,
        ]
      );

      console.log(`✅ Snapshot + HQS saved for ${normalized.symbol}`);

    } catch (err) {
      console.error(`❌ Error for ${normalized.symbol}:`, err.message);
    }
  }

  console.log("✅ Snapshot complete");
}
