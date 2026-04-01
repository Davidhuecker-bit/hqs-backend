"use strict";

const { classifyDbError, checkDbReady, waitForDb, DB_ERROR_TYPES } = require("../utils/dbHealth");

// ── classifyDbError ────────────────────────────────────────────────────────

describe("classifyDbError", () => {
  test("returns QUERY_ERROR for null/undefined", () => {
    expect(classifyDbError(null)).toBe(DB_ERROR_TYPES.QUERY_ERROR);
    expect(classifyDbError(undefined)).toBe(DB_ERROR_TYPES.QUERY_ERROR);
  });

  test.each([
    ["connection terminated unexpectedly"],
    ["server closed the connection"],
    ["ECONNREFUSED something"],
    ["enotfound host"],
    ["connect econnreset"],
  ])("classifies '%s' as DB_DOWN", (msg) => {
    expect(classifyDbError(new Error(msg))).toBe(DB_ERROR_TYPES.DB_DOWN);
  });

  test("classifies error with code ECONNREFUSED as DB_DOWN", () => {
    const err = new Error("failed");
    err.code = "ECONNREFUSED";
    expect(classifyDbError(err)).toBe(DB_ERROR_TYPES.DB_DOWN);
  });

  test("classifies error with code ENOTFOUND as DB_DOWN", () => {
    const err = new Error("failed");
    err.code = "ENOTFOUND";
    expect(classifyDbError(err)).toBe(DB_ERROR_TYPES.DB_DOWN);
  });

  test("classifies recovery message as DB_RECOVERING", () => {
    expect(classifyDbError(new Error("server is in recovery mode"))).toBe(
      DB_ERROR_TYPES.DB_RECOVERING
    );
  });

  test.each([
    ["tls handshake failed"],
    ["ssl certificate verify failed"],
    ["client network socket disconnected before secure TLS connection"],
    ["certificate has expired"],
    ["handshake error"],
  ])("classifies '%s' as TLS_ISSUE", (msg) => {
    expect(classifyDbError(new Error(msg))).toBe(DB_ERROR_TYPES.TLS_ISSUE);
  });

  test("classifies timeout message as TIMEOUT", () => {
    expect(classifyDbError(new Error("query timed out"))).toBe(DB_ERROR_TYPES.TIMEOUT);
  });

  test("classifies pg statement_timeout code 57014 as TIMEOUT", () => {
    const err = new Error("canceling statement due to statement timeout");
    err.code = "57014";
    expect(classifyDbError(err)).toBe(DB_ERROR_TYPES.TIMEOUT);
  });

  test("classifies unknown error as QUERY_ERROR", () => {
    expect(classifyDbError(new Error("syntax error near SELECT"))).toBe(
      DB_ERROR_TYPES.QUERY_ERROR
    );
  });
});

// ── checkDbReady ──────────────────────────────────────────────────────────

describe("checkDbReady", () => {
  test("returns ready:true when pool.query resolves", async () => {
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const result = await checkDbReady(pool);
    expect(result).toEqual({ ready: true });
    expect(pool.query).toHaveBeenCalledWith("SELECT 1");
  });

  test("returns ready:false and errorType when pool.query rejects", async () => {
    const err = new Error("connection terminated unexpectedly");
    const pool = { query: jest.fn().mockRejectedValue(err) };
    const result = await checkDbReady(pool);
    expect(result.ready).toBe(false);
    expect(result.errorType).toBe(DB_ERROR_TYPES.DB_DOWN);
    expect(result.message).toBe(err.message);
  });

  test("includes message from the thrown error", async () => {
    const err = new Error("syntax error");
    const pool = { query: jest.fn().mockRejectedValue(err) };
    const result = await checkDbReady(pool);
    expect(result.message).toBe("syntax error");
  });
});

// ── waitForDb ─────────────────────────────────────────────────────────────

describe("waitForDb", () => {
  test("returns true immediately when DB is ready on first attempt", async () => {
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const result = await waitForDb(pool, { maxRetries: 3, delayMs: 0 });
    expect(result).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test("returns true after retries when DB recovers on 2nd attempt", async () => {
    const err = new Error("ECONNREFUSED");
    const pool = {
      query: jest
        .fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({}),
    };
    const result = await waitForDb(pool, { maxRetries: 3, delayMs: 0 });
    expect(result).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test("returns false after all retries are exhausted", async () => {
    const err = new Error("ECONNREFUSED");
    const pool = { query: jest.fn().mockRejectedValue(err) };
    const result = await waitForDb(pool, { maxRetries: 3, delayMs: 0 });
    expect(result).toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  test("respects maxRetries option", async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error("down")) };
    await waitForDb(pool, { maxRetries: 5, delayMs: 0 });
    expect(pool.query).toHaveBeenCalledTimes(5);
  });
});
