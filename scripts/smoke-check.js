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

const REQUEST_TIMEOUT_MS = 10000;

const CHECKS = [
  {
    name:    "GET /health",
    path:    "/health",
    assert:  (body) => body.success === true || body.db === "ok",
  },
  {
    name:    "GET /api/admin/pipeline-status",
    path:    "/api/admin/pipeline-status",
    assert:  (body) => body.success === true && body.stages != null,
  },
  {
    name:    "GET /api/admin/table-health",
    path:    "/api/admin/table-health",
    assert:  (body) => body.success === true && body.overallStatus != null,
  },
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
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

      if (passed) {
        console.log(`  ✅ ${check.name}  (HTTP ${status})`);
        // Print useful fields for quick triage
        if (check.path === "/health") {
          console.log(`     db=${body.db || "?"}  ready=${body.ready}  jobsEnabled=${body.jobsEnabled}`);
        } else if (check.path === "/api/admin/pipeline-status") {
          const stages = body.stages || {};
          for (const [stage, s] of Object.entries(stages)) {
            console.log(`     ${stage}: success=${s.successCount} failed=${s.failedCount} skipped=${s.skippedCount} source=${s.source || "?"} lastUpdated=${s.lastUpdated || "never"}`);
          }
        } else if (check.path === "/api/admin/table-health") {
          console.log(`     overall=${body.overallStatus}  green=${body.green}  yellow=${body.yellow}  red=${body.red}`);
        }
      } else {
        console.error(`  ❌ ${check.name}  (HTTP ${status}) – assertion failed`);
        console.error(`     Response: ${JSON.stringify(body).slice(0, 200)}`);
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
