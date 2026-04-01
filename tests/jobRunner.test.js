"use strict";

// jobRunner depends on logger, dbHealth and optionally axios.
// We mock them so that tests run without real network/db access.

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock("../utils/dbHealth", () => ({
  waitForDb: jest.fn(),
  classifyDbError: jest.fn(() => "UNKNOWN"),
}));

const { runJob } = require("../utils/jobRunner");
const { waitForDb } = require("../utils/dbHealth");

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Successful execution ──────────────────────────────────────────────────

describe("runJob – successful execution", () => {
  test("returns success:true and skipped:false when job completes", async () => {
    const result = await runJob("test-job", async () => ({}));
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(false);
  });

  test("reports durationMs as a non-negative number", async () => {
    const result = await runJob("test-job", async () => ({}));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("extracts processedCount from result.processedCount", async () => {
    const result = await runJob("test-job", async () => ({ processedCount: 7 }));
    expect(result.processedCount).toBe(7);
  });

  test("extracts processedCount from result.processed", async () => {
    const result = await runJob("test-job", async () => ({ processed: 5 }));
    expect(result.processedCount).toBe(5);
  });

  test("extracts processedCount from result.count", async () => {
    const result = await runJob("test-job", async () => ({ count: 3 }));
    expect(result.processedCount).toBe(3);
  });

  test("defaults processedCount to 0 when job returns nothing", async () => {
    const result = await runJob("test-job", async () => {});
    expect(result.processedCount).toBe(0);
  });

  test("defaults processedCount to 0 when job returns null", async () => {
    const result = await runJob("test-job", async () => null);
    expect(result.processedCount).toBe(0);
  });
});

// ── Body-signalled skip ───────────────────────────────────────────────────

describe("runJob – body-signalled skip", () => {
  test("returns skipped:true when job body returns skipped:true", async () => {
    const result = await runJob("lock-job", async () => ({
      skipped: true,
      skipReason: "already_running",
    }));
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("already_running");
  });
});

// ── Error handling ────────────────────────────────────────────────────────

describe("runJob – error handling", () => {
  test("returns success:false when job throws", async () => {
    const result = await runJob("broken-job", async () => {
      throw new Error("something went wrong");
    });
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(false);
  });

  test("captures error message in result.error", async () => {
    const result = await runJob("broken-job", async () => {
      throw new Error("db exploded");
    });
    expect(result.error).toBe("db exploded");
  });

  test("processedCount is 0 on failure", async () => {
    const result = await runJob("broken-job", async () => {
      throw new Error("fail");
    });
    expect(result.processedCount).toBe(0);
  });

  test("still returns durationMs on failure", async () => {
    const result = await runJob("broken-job", async () => {
      throw new Error("fail");
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── DB readiness guard ────────────────────────────────────────────────────

describe("runJob – DB readiness guard", () => {
  const fakePool = {};

  test("skips job and returns skipped:true when DB is not ready", async () => {
    waitForDb.mockResolvedValueOnce(false);
    const fn = jest.fn();
    const result = await runJob("guarded-job", fn, { pool: fakePool });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("db_not_ready");
    expect(result.success).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  test("runs job when DB becomes ready", async () => {
    waitForDb.mockResolvedValueOnce(true);
    const fn = jest.fn().mockResolvedValue({ processedCount: 2 });
    const result = await runJob("guarded-job", fn, { pool: fakePool });
    expect(result.success).toBe(true);
    expect(result.processedCount).toBe(2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("passes dbRetries and dbDelayMs options to waitForDb", async () => {
    waitForDb.mockResolvedValueOnce(true);
    await runJob("guarded-job", async () => ({}), {
      pool: fakePool,
      dbRetries: 7,
      dbDelayMs: 500,
    });
    expect(waitForDb).toHaveBeenCalledWith(fakePool, {
      maxRetries: 7,
      delayMs: 500,
      label: "job:guarded-job",
    });
  });
});
