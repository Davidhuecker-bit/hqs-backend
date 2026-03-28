#!/usr/bin/env node
"use strict";

/**
 * scripts/smoke-check.js
 *
 * Quick health / status probe for local dev and Railway post-deploy checks.
 *
 * Usage:
 *   node scripts/smoke-check.js [BASE_URL]
 *
 * Examples:
 *   node scripts/smoke-check.js                          # http://localhost:3000
 *   node scripts/smoke-check.js https://my-app.up.railway.app
 *
 * Exit code:
 *   0  – all checks passed
 *   1  – one or more checks failed
 */

const https = require("https");
const http  = require("http");

const BASE_URL = (process.argv[2] || process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
const DEMO_SNAPSHOT_HARD_STALE_HOURS = Number(process.env.DEMO_SNAPSHOT_HARD_STALE_HOURS || 72);

const REQUEST_TIMEOUT_MS = 10000;

const CHECKS = [
  {
    name:    "GET /health",
    path:    "/health",
    assert:  (body) => body.success === true || body.db === "ok",
    shape: ["success", "generatedAt", "db", "ready", "jobsEnabled"],
  },
  {
    name:    "GET /api/admin/pipeline-status",
    path:    "/api/admin/pipeline-status",
    assert:  (body) => body.success === true && body.stages != null,
    shape: ["success", "generatedAt", "stages"],
  },
  {
    name:    "GET /api/admin/table-health",
    path:    "/api/admin/table-health",
    assert:  (body) => body.success === true && body.overallStatus != null,
    shape: ["success", "generatedAt", "overallStatus", "green", "yellow", "red", "tables"],
  },
  {
    name:    "GET /api/admin/overview",
    path:    "/api/admin/overview",
    assert:  (body) => body.success === true && body.dataStatus != null,
    shape: ["success", "generatedAt", "dataStatus", "insights", "diagnostics"],
  },
  {
    name:    "GET /api/admin/demo-portfolio",
    path:    "/api/admin/demo-portfolio",
    assert:  (body) => {
      const holdings = body.holdings || [];
      const allEur = holdings.every((h) => (h?.currency || "EUR") === "EUR");
      const noHardStaleSnapshots = holdings.every((h) => {
        const age = h?.dataAgeHours?.snapshotAgeHours;
        return age == null || age <= DEMO_SNAPSHOT_HARD_STALE_HOURS;
      });
      return body.success === true && Array.isArray(holdings) && body.summary != null && body.currency === "EUR" && allEur && noHardStaleSnapshots;
    },
    shape: ["success", "generatedAt", "dataStatus", "holdings", "summary", "portfolioId", "symbolCount", "currency", "priceSource"],
  },
  {
    name:    "GET /api/admin/portfolio-twin",
    path:    "/api/admin/portfolio-twin",
    assert:  (body) => body.success === true && body.portfolioTwin?.currency === "EUR",
    shape: ["success", "portfolioTwin"],
  },
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const options = { timeout: REQUEST_TIMEOUT_MS };
    if (ADMIN_API_KEY && url.includes("/api/admin")) {
      options.headers = { "X-Admin-Key": ADMIN_API_KEY };
    }
    const req = mod.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000} s`));
    });
  });
}

async function run() {
  console.log(`\n🔍 Smoke check against: ${BASE_URL}\n`);

  let allPassed = true;

  for (const check of CHECKS) {
    const url = `${BASE_URL}${check.path}`;
    try {
      const { status, body } = await fetch(url);
      const passed = check.assert(body);
      const missingShapeFields = (check.shape || []).filter((f) => !(f in body));

      if (passed && missingShapeFields.length === 0) {
        console.log(`  ✅ ${check.name}  (HTTP ${status})`);
        // Print useful fields for quick triage
        if (check.path === "/health") {
          console.log(`     db=${body.db || "?"}  ready=${body.ready}  jobsEnabled=${body.jobsEnabled}  generatedAt=${body.generatedAt || "?"}`);
        } else if (check.path === "/api/admin/pipeline-status") {
          const stages = body.stages || {};
          for (const [stage, s] of Object.entries(stages)) {
            console.log(`     ${stage}: success=${s.successCount} failed=${s.failedCount} skipped=${s.skippedCount} source=${s.source || "?"} lastUpdated=${s.lastUpdated || "never"}`);
          }
        } else if (check.path === "/api/admin/table-health") {
          console.log(`     overall=${body.overallStatus}  green=${body.green}  yellow=${body.yellow}  red=${body.red}`);
        } else if (check.path === "/api/admin/overview") {
          console.log(`     dataStatus=${body.dataStatus}  partialErrors=${(body.partialErrors || []).length}  emptyFields=${(body.emptyFields || []).length}`);
          if ((body.partialErrors || []).length > 0) {
            console.warn(`     ⚠️  partial errors: ${body.partialErrors.map((e) => e.field || e).join(", ")}`);
          }
        } else if (check.path === "/api/admin/demo-portfolio") {
          const s = body.summary || {};
          console.log(`     currency=${body.currency ?? "?"}  priceSource=${body.priceSource ?? "?"}  total=${s.total}  green=${s.green}  yellow=${s.yellow}  red=${s.red}  topBottleneck=${s.topBottleneck ?? "none"}`);
          console.log(`     avgCompleteness=${s.avgCompletenessScore ?? "?"}  avgReliability=${s.avgReliabilityScore ?? "?"}`);
          if (s.byReason) console.log(`     byReason=${JSON.stringify(s.byReason)}`);
          const holdings = body.holdings || [];
          const nonEur = holdings.filter((h) => (h.currency || "EUR") !== "EUR");
          const staleSnapshots = holdings.filter((h) => (h.dataAgeHours?.snapshotAgeHours ?? 0) > DEMO_SNAPSHOT_HARD_STALE_HOURS);
          const missingNews = holdings.filter((h) => (h.latestNewsCount || 0) === 0);
          console.log(`     mixedCurrency=${nonEur.length} staleSnapshots>${DEMO_SNAPSHOT_HARD_STALE_HOURS}h=${staleSnapshots.length} holdingsMissingNews=${missingNews.length}`);
          // Currency/FX diagnostics on first holding
          const firstHolding = (body.holdings || [])[0];
          if (firstHolding) {
            console.log(`     sample[${firstHolding.symbol}]: currency=${firstHolding.currency ?? "?"}  priceSource=${firstHolding.priceSource ?? "?"}  fxApplied=${firstHolding.fxApplied ?? "?"}`);
          }
        } else if (check.path === "/api/admin/portfolio-twin") {
          const twin = body.portfolioTwin || {};
          console.log(`     currency=${twin.currency ?? "?"}  priceSource=${twin.priceSource ?? "?"}  openCount=${twin.openCount ?? "?"}  closedCount=${twin.closedCount ?? "?"}`);
          const firstPos = (twin.openPositions || [])[0];
          if (firstPos) {
            console.log(`     sample open pos[${firstPos.symbol}]: currency=${firstPos.currency ?? "?"}  priceSource=${firstPos.priceSource ?? "?"}`);
          }
        }
      } else {
        console.error(`  ❌ ${check.name}  (HTTP ${status}) – assertion failed`);
        if (!passed) {
          console.error(`     Response: ${JSON.stringify(body).slice(0, 200)}`);
        }
        if (missingShapeFields.length > 0) {
          console.error(`     Missing shape fields: ${missingShapeFields.join(", ")}`);
        }
        allPassed = false;
      }
    } catch (err) {
      console.error(`  ❌ ${check.name}  – ${err.message}`);
      allPassed = false;
    }
  }

  console.log();
  if (allPassed) {
    console.log("✅ All smoke checks passed.\n");
    process.exit(0);
  } else {
    console.error("❌ One or more smoke checks FAILED.\n");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
