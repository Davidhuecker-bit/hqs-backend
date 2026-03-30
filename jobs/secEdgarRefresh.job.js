"use strict";

/**
 * SEC EDGAR Refresh Job
 *
 * Periodically refreshes SEC EDGAR data (submissions + facts) for all active
 * symbols in the universe. Runs through the universe in rolling batches so
 * each run does not overload the SEC EDGAR API.
 *
 * SEC EDGAR rate limit: ≤ 10 requests/second per their fair-use policy.
 * This job uses an inter-symbol delay to stay comfortably below that.
 *
 * Writer:  this job (via refreshSecEdgarSnapshot → upsertSecEdgarCompanySubmission,
 *           replaceSecEdgarFilingSignals, replaceSecEdgarCompanyFacts)
 * Readers: GET /api/sec-edgar?symbol=X (loadSecEdgarSnapshotBySymbol)
 *
 * Schedule: daily (configure in Railway cron, e.g. 0 3 * * *)
 *
 * Configuration:
 *   SEC_EDGAR_USER_AGENT    – required: "YourApp contact@example.com"
 *   SEC_EDGAR_BATCH_SIZE    – symbols per run (default: 50)
 *   SEC_EDGAR_DELAY_MS      – ms between symbols (default: 200)
 *   SEC_EDGAR_FILING_LIMIT  – filings per symbol (default: 12)
 *   SEC_EDGAR_FACT_LIMIT    – facts per symbol (default: 30)
 *   SEC_EDGAR_LOCK_TTL_SECS – lock TTL in seconds (default: 14400 = 4h)
 */

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { refreshSecEdgarSnapshot } = require("../services/secEdgar.service");
const { initSecEdgarTables } = require("../services/secEdgar.repository");
const {
  initJobLocksTable,
  acquireLock,
  releaseLock,
} = require("../services/jobLock.repository");
const {
  initUniverseTables,
  listActiveUniverseSymbols,
} = require("../services/universe.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");
const { getSharedPool, closeAllPools } = require("../config/database");

const pool = getSharedPool();

// ── Configuration ────────────────────────────────────────────────────────────
const BATCH_SIZE = Math.max(
  1,
  Math.min(Number(process.env.SEC_EDGAR_BATCH_SIZE || 50), 200)
);

const DELAY_MS = Math.max(
  100,
  Number(process.env.SEC_EDGAR_DELAY_MS || 200)
);

const FILING_LIMIT = Math.max(
  1,
  Number(process.env.SEC_EDGAR_FILING_LIMIT || 12)
);

const FACT_LIMIT = Math.max(
  1,
  Number(process.env.SEC_EDGAR_FACT_LIMIT || 30)
);

const LOCK_TTL_SECS =
  Number.parseInt(process.env.SEC_EDGAR_LOCK_TTL_SECS || "14400", 10) || 14400;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  return runJob(
    "secEdgarRefresh",
    async () => {
      await initJobLocksTable();
      await initSecEdgarTables();
      await initUniverseTables();

      const won = await acquireLock("sec_edgar_refresh_job", LOCK_TTL_SECS);
      if (!won) {
        logger.warn("[job:secEdgarRefresh] skipped – lock held", {
          lockTtlSeconds: LOCK_TTL_SECS,
          skipReason: "lock_held",
        });
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      const startMs = Date.now();

      try {
        const symbols = await listActiveUniverseSymbols(BATCH_SIZE);

        logger.info("[job:secEdgarRefresh] starting", {
          symbolCount: symbols.length,
          batchSize: BATCH_SIZE,
          delayMs: DELAY_MS,
          filingLimit: FILING_LIMIT,
          factLimit: FACT_LIMIT,
        });

        let succeeded = 0;
        let failed = 0;
        let warnings = 0;
        const errorDetails = [];

        for (let i = 0; i < symbols.length; i++) {
          const symbol = symbols[i];

          try {
            await refreshSecEdgarSnapshot(symbol, {
              filingLimit: FILING_LIMIT,
              factLimit: FACT_LIMIT,
            });
            succeeded += 1;
          } catch (err) {
            const statusCode = err?.statusCode;

            // 404 = SEC has no data for this symbol – expected for some symbols
            if (statusCode === 404) {
              warnings += 1;
              logger.debug("[job:secEdgarRefresh] symbol not found in SEC", {
                symbol,
              });
            } else {
              failed += 1;
              errorDetails.push({
                symbol,
                message: err?.message || String(err),
              });

              logger.warn("[job:secEdgarRefresh] symbol failed", {
                symbol,
                statusCode,
                message: err?.message || String(err),
              });
            }
          }

          if (i < symbols.length - 1) {
            await delay(DELAY_MS);
          }
        }

        const durationMs = Date.now() - startMs;
        const processedCount = succeeded + failed + warnings;

        try {
          await savePipelineStage("sec_edgar_refresh", {
            inputCount: symbols.length,
            successCount: succeeded,
            failedCount: failed,
            skippedCount: warnings,
            status: "success",
          });
        } catch (stageErr) {
          logger.warn("[job:secEdgarRefresh] savePipelineStage failed", {
            message: stageErr?.message,
          });
        }

        logger.info("[job:secEdgarRefresh] done", {
          processed: processedCount,
          succeeded,
          failed,
          warnings,
          durationMs,
          errorSample: errorDetails.slice(0, 3),
        });

        return {
          processedCount,
          succeeded,
          failed,
          warnings,
          durationMs,
        };
      } catch (err) {
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("sec_edgar_refresh", {
            inputCount: 0,
            successCount: 0,
            failedCount: 1,
            skippedCount: 0,
            status: "failed",
          });
        } catch (stageErr) {
          logger.warn("[job:secEdgarRefresh] savePipelineStage failed after job error", {
            message: stageErr?.message,
          });
        }

        logger.error("[job:secEdgarRefresh] failed", {
          message: err?.message || String(err),
          durationMs,
          stack: err?.stack,
        });

        throw err;
      } finally {
        await releaseLock("sec_edgar_refresh_job").catch((lockErr) => {
          logger.warn("[job:secEdgarRefresh] lock release failed", {
            message: lockErr?.message,
          });
        });
      }
    },
    { pool, dbRetries: 3, dbDelayMs: 2000 }
  );
}

module.exports = { run };

// ── Standalone entry point ──────────────────────────────────────────────────
if (require.main === module) {
  let exitCode = 0;

  run()
    .catch((err) => {
      exitCode = 1;
      logger.error("[job:secEdgarRefresh] fatal", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
    })
    .finally(async () => {
      await closeAllPools().catch(() => {});
      process.exit(exitCode);
    });
}
