async function getSignalKPIs({ windowDays = 90 } = {}) {
  const safeDays = Math.max(7, Math.min(Number(windowDays) || 90, 365));

  const toPct = (value) => {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Number((num * 100).toFixed(2));
  };

  const detectTimingBucket = (row) => {
    try {
      const entryPrice = Number(row?.entry_price);
      const perf24Raw = row?.performance_24h;
      const perf7dRaw = row?.performance_7d;

      const perf24 =
        perf24Raw && typeof perf24Raw === "object"
          ? Number(perf24Raw.price_delta ?? perf24Raw.return ?? null)
          : null;

      const perf7d =
        perf7dRaw && typeof perf7dRaw === "object"
          ? Number(perf7dRaw.price_delta ?? perf7dRaw.return ?? null)
          : null;

      if (!Number.isFinite(entryPrice)) return "unklar";

      const has24 = Number.isFinite(perf24);
      const has7 = Number.isFinite(perf7d);

      if (!has24 && !has7) return "unklar";

      if (has24 && perf24 > 0.03) return "passend";
      if (has24 && perf24 < -0.03) return "zu früh";

      if (has7 && perf7d > 0.03) return "zu spät";
      if (has7 && perf7d < -0.03) return "zu früh";

      return "unklar";
    } catch (_) {
      return "unklar";
    }
  };

  try {
    const [outcomeRes, timingRes, agentRes, nearMissRes] = await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE is_evaluated = TRUE) AS evaluated,
          COUNT(*) FILTER (WHERE is_evaluated = FALSE) AS open_signals,
          COUNT(*) FILTER (WHERE performance_7d IS NOT NULL) AS has_7d,

          COUNT(*) FILTER (
            WHERE performance_7d IS NOT NULL
              AND (
                (final_conviction >= 50 AND (performance_7d->>'price_delta')::numeric > 0.03)
                OR
                (final_conviction < 50 AND (performance_7d->>'price_delta')::numeric < -0.03)
              )
          ) AS correct_7d,

          COUNT(*) FILTER (
            WHERE is_evaluated = TRUE
              AND actual_return IS NOT NULL
              AND (
                (final_conviction >= 50 AND actual_return > 0.03)
                OR
                (final_conviction < 50 AND actual_return < -0.03)
              )
          ) AS correct_evaluated,

          AVG(
            CASE
              WHEN performance_7d IS NOT NULL
              THEN (performance_7d->>'price_delta')::numeric
              ELSE NULL
            END
          ) AS avg_return_7d,

          AVG(
            CASE
              WHEN is_evaluated = TRUE AND actual_return IS NOT NULL
              THEN actual_return
              ELSE NULL
            END
          ) AS avg_return_evaluated

        FROM outcome_tracking
        WHERE predicted_at >= NOW() - INTERVAL '1 day' * $1
        `,
        [safeDays]
      ),

      pool.query(
        `
        SELECT
          entry_price,
          performance_24h,
          performance_7d
        FROM outcome_tracking
        WHERE predicted_at >= NOW() - INTERVAL '1 day' * $1
        `,
        [safeDays]
      ),

      pool.query(
        `
        SELECT
          COUNT(*) AS total_verified,
          COUNT(*) FILTER (WHERE was_correct = TRUE) AS correct,
          COUNT(*) FILTER (WHERE was_correct = FALSE) AS incorrect
        FROM agent_forecasts
        WHERE verified_at IS NOT NULL
          AND forecasted_at >= NOW() - INTERVAL '1 day' * $1
        `,
        [safeDays]
      ),

      pool
        .query(
          `
          SELECT AVG(saved_capital) AS avg_saved
          FROM guardian_near_miss
          WHERE saved_capital IS NOT NULL
            AND created_at >= NOW() - INTERVAL '1 day' * $1
          `,
          [safeDays]
        )
        .catch(() => ({ rows: [{ avg_saved: null }] })),
    ]);

    const ov = outcomeRes?.rows?.[0] || {};
    const ag = agentRes?.rows?.[0] || {};
    const nm = nearMissRes?.rows?.[0] || {};

    const timingDist = {
      passend: 0,
      zuFrueh: 0,
      zuSpaet: 0,
      unklar: 0,
    };

    for (const row of timingRes?.rows || []) {
      const bucket = detectTimingBucket(row);

      if (bucket === "passend") timingDist.passend++;
      else if (bucket === "zu früh") timingDist.zuFrueh++;
      else if (bucket === "zu spät") timingDist.zuSpaet++;
      else timingDist.unklar++;
    }

    const total = Number(ov.total || 0);
    const evaluated = Number(ov.evaluated || 0);
    const openCount = Number(ov.open_signals || 0);
    const has7d = Number(ov.has_7d || 0);
    const correct7d = Number(ov.correct_7d || 0);
    const correctEvaluated = Number(ov.correct_evaluated || 0);

    const agentVerified = Number(ag.total_verified || 0);
    const agentCorrect = Number(ag.correct || 0);

    const avgSavedCapital =
      nm.avg_saved !== null && nm.avg_saved !== undefined
        ? Number(Number(nm.avg_saved).toFixed(2))
        : null;

    return {
      success: true,
      dataStatus: total === 0 ? "empty" : has7d === 0 ? "partial" : "full",
      _meta: {
        source: "outcome_tracking + agent_forecasts + guardian_near_miss",
        windowDays: safeDays,
        generatedAt: new Date().toISOString(),
        note: "KPI-Endpoint bewusst auf schnelle Aggregation reduziert; market_snapshots-Range-Scans wurden entfernt, um Admin-Timeouts zu vermeiden.",
      },
      kpis: {
        totalSignals: total,
        evaluableSignals7d: has7d,
        evaluableSignals30d: evaluated,
        openSignals: openCount,

        hitRate7dPct: has7d > 0 ? Math.round((correct7d / has7d) * 100) : null,
        hitRate30dPct: evaluated > 0 ? Math.round((correctEvaluated / evaluated) * 100) : null,

        avgReturn7dPct: toPct(ov.avg_return_7d),
        avgReturn30dPct: toPct(ov.avg_return_evaluated),

        avgMaxUpsidePct: null,
        avgMaxDrawdownPct: null,

        avgSavedCapitalEur: avgSavedCapital,

        agentForecastAccuracyPct:
          agentVerified > 0 ? Math.round((agentCorrect / agentVerified) * 100) : null,
        agentForecastsVerified: agentVerified,

        timingDistribution: {
          passend: timingDist.passend,
          zuFrueh: timingDist.zuFrueh,
          zuSpaet: timingDist.zuSpaet,
          unklar: timingDist.unklar,
        },
      },
    };
  } catch (err) {
    try {
      logger.error("signalHistory.getSignalKPIs error", {
        message: err.message,
      });
    } catch (_) {}

    return {
      success: false,
      error: "getSignalKPIs_failed",
      message: err.message,
      kpis: null,
    };
  }
}
