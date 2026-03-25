"use strict";

/**
 * SEC EDGAR Refresh Job
 *
 * Periodically refreshes SEC EDGAR data (submissions + facts) for all active
 * symbols in the universe.  Runs through the universe in rolling batches so
 * each run does not overload the SEC EDGAR API.
 *
 * SEC EDGAR rate limit: ≤ 10 requests/second per their fair-use policy.
 * This job uses a 200 ms inter-symbol delay to stay comfortably below that.
 *
 * Writer:  this job (via refreshSecEdgarSnapshot → upsertSecEdgarCompanySubmission,
 *           replaceSecEdgarFilingSignals, replaceSecEdgarCompanyFacts)
 * Readers: GET /api/sec-edgar?symbol=X (loadSecEdgarSnapshotBySymbol)
 *
 * Schedule: daily (configure in Railway cron, e.g. 0 3 * * *)
 *
 * Configuration:
 *   SEC_EDGAR_USER_AGENT     – required: "YourApp contact@example.com"
 *   SEC_EDGAR_BATCH_SIZE     – symbols per run (default: 50)
 *   SEC_EDGAR_DELAY_MS       – ms between symbols (default: 200)
 *   SEC_EDGAR_FILING_LIMIT   – filings per symbol (default: 12)
 *   SEC_EDGAR_FACT_LIMIT     – facts per symbol (default: 30)
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

const BATCH_SIZE   = Math.max(1, Math.min(Number(process.env.SEC_EDGAR_BATCH_SIZE  || 50),  200));
const DELAY_MS     = Math.max(100, Number(process.env.SEC_EDGAR_DELAY_MS           || 200));
const FILING_LIMIT = Math.max(1,   Number(process.env.SEC_EDGAR_FILING_LIMIT       || 12));
const FACT_LIMIT   = Math.max(1,   Number(process.env.SEC_EDGAR_FACT_LIMIT         || 30));
const LOCK_TTL_SECS = 4 * 60 * 60; // 4 hours – generous, job may run long on large universe

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
        logger.warn("[job:secEdgarRefresh] skipped – lock held");
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      try {
        const symbols = await listActiveUniverseSymbols(BATCH_SIZE);
        logger.info("[job:secEdgarRefresh] starting", {
          symbolCount: symbols.length,
          batchSize: BATCH_SIZE,
          delayMs: DELAY_MS,
        });

        let processed = 0;
        let succeeded = 0;
        let failed    = 0;
        const errors  = [];

        for (const symbol of symbols) {
          try {
            await refreshSecEdgarSnapshot(symbol, {
              filingLimit: FILING_LIMIT,
              factLimit: FACT_LIMIT,
            });
            succeeded += 1;
          } catch (err) {
            failed += 1;
            const statusCode = err?.statusCode;
            // 404 = SEC doesn't have data for this symbol – expected for non-US stocks
            if (statusCode !== 404) {
              errors.push({ symbol, message: err.message });
              logger.warn("[job:secEdgarRefresh] symbol failed", {
                symbol,
                statusCode,
                message: err.message,
              });
            }
          }

          processed += 1;

          if (processed < symbols.length) {
            await delay(DELAY_MS);
          }
        }

        await savePipelineStage("sec_edgar_refresh", {
          inputCount: symbols.length,
          successCount: succeeded,
          failedCount: failed,
        });

        logger.info("[job:secEdgarRefresh] done", {
          processed,
          succeeded,
          failed,
          errorSample: errors.slice(0, 3),
        });

        return { processedCount: succeeded, succeeded, failed };
      } finally {
        await releaseLock("sec_edgar_refresh_job").catch((err) => {
          logger.warn("[job:secEdgarRefresh] lock release failed", {
            message: err?.message,
          });
        });
      }
    },
    { pool, dbRetries: 3, dbDelayMs: 2000 }
  );
}

if (require.main === module) {
  run()
    .then(() => {
      closeAllPools().catch(() => {});
      process.exit(0);
    })
    .catch((err) => {
      logger.error("secEdgarRefresh job failed", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
      closeAllPools().catch(() => {});
      process.exit(1);
    });
}

module.exports = { run };
