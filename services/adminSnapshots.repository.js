"use strict";

const { Pool } = require("pg");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function parseSnapshotValue(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function normalizeSnapshotRow(row) {
  if (!row) return null;

  return {
    insights: parseSnapshotValue(row.insights) || {},
    diagnostics: parseSnapshotValue(row.diagnostics) || {},
    validation: parseSnapshotValue(row.validation) || {},
    tuning: parseSnapshotValue(row.tuning) || {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

async function initAdminSnapshotsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_snapshots (
      id SERIAL PRIMARY KEY,
      insights JSONB NOT NULL,
      diagnostics JSONB NOT NULL,
      validation JSONB NOT NULL,
      tuning JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_snapshots_created_at
    ON admin_snapshots (created_at DESC);
  `);

  if (logger?.info) logger.info("admin_snapshots ready");
}

async function saveAdminSnapshot({ insights, diagnostics, validation, tuning }) {
  await pool.query(
    `
    INSERT INTO admin_snapshots (insights, diagnostics, validation, tuning)
    VALUES ($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb)
    `,
    [
      JSON.stringify(insights || {}),
      JSON.stringify(diagnostics || {}),
      JSON.stringify(validation || {}),
      JSON.stringify(tuning || {}),
    ]
  );
}

async function loadAdminSnapshotBefore(intervalValue) {
  const res = await pool.query(
    `
    SELECT insights, diagnostics, validation, tuning, created_at
    FROM admin_snapshots
    WHERE created_at <= NOW() - $1::interval
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [String(intervalValue || "24 hours")]
  );

  return normalizeSnapshotRow(res.rows?.[0]);
}

module.exports = {
  initAdminSnapshotsTable,
  saveAdminSnapshot,
  loadAdminSnapshotBefore,
};
