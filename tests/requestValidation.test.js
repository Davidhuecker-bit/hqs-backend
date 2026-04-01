"use strict";

const {
  badRequest,
  parseBoolean,
  parseEnum,
  parseInteger,
  parseNumber,
  parseSymbol,
} = require("../utils/requestValidation");

// ── badRequest ────────────────────────────────────────────────────────────

describe("badRequest", () => {
  function makeRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  test("sets HTTP 400", () => {
    const res = makeRes();
    badRequest(res, "oops");
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("returns success:false and message", () => {
    const res = makeRes();
    badRequest(res, "bad input");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: "bad input" })
    );
  });

  test("merges extra details into response", () => {
    const res = makeRes();
    badRequest(res, "bad input", { field: "symbol" });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ field: "symbol" })
    );
  });
});

// ── parseInteger ─────────────────────────────────────────────────────────

describe("parseInteger", () => {
  test("returns defaultValue when value is absent", () => {
    expect(parseInteger(undefined, { defaultValue: 5 })).toEqual({ value: 5 });
  });

  test("returns null default when no defaultValue given", () => {
    expect(parseInteger(undefined)).toEqual({ value: null });
  });

  test("returns error when required and missing", () => {
    const result = parseInteger(undefined, { required: true, label: "limit" });
    expect(result.error).toContain("limit");
  });

  test("parses a valid integer string", () => {
    expect(parseInteger("42")).toEqual({ value: 42 });
  });

  test("parses a numeric value directly", () => {
    expect(parseInteger(7)).toEqual({ value: 7 });
  });

  test("returns error for non-integer float string", () => {
    expect(parseInteger("3.5")).toEqual(
      expect.objectContaining({ error: expect.stringContaining("integer") })
    );
  });

  test("returns error for non-numeric string", () => {
    expect(parseInteger("abc")).toEqual(
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  test("clamps value to min", () => {
    expect(parseInteger("1", { min: 5 })).toEqual({ value: 5 });
  });

  test("clamps value to max", () => {
    expect(parseInteger("100", { max: 50 })).toEqual({ value: 50 });
  });

  test("does not clamp value within range", () => {
    expect(parseInteger("10", { min: 1, max: 20 })).toEqual({ value: 10 });
  });
});

// ── parseNumber ──────────────────────────────────────────────────────────

describe("parseNumber", () => {
  test("returns defaultValue when value is absent", () => {
    expect(parseNumber(undefined, { defaultValue: 1.5 })).toEqual({ value: 1.5 });
  });

  test("returns error when required and missing", () => {
    const result = parseNumber(null, { required: true, label: "score" });
    expect(result.error).toContain("score");
  });

  test("parses float string", () => {
    expect(parseNumber("3.14")).toEqual({ value: 3.14 });
  });

  test("parses integer string", () => {
    expect(parseNumber("10")).toEqual({ value: 10 });
  });

  test("returns error for NaN-producing string", () => {
    expect(parseNumber("notANumber")).toEqual(
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  test("returns error for Infinity", () => {
    expect(parseNumber(Infinity)).toEqual(
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  test("clamps to min", () => {
    expect(parseNumber("-5", { min: 0 })).toEqual({ value: 0 });
  });

  test("clamps to max", () => {
    expect(parseNumber("200", { max: 100 })).toEqual({ value: 100 });
  });
});

// ── parseBoolean ─────────────────────────────────────────────────────────

describe("parseBoolean", () => {
  test("returns false default when value absent", () => {
    expect(parseBoolean(undefined)).toEqual({ value: false });
  });

  test("respects custom defaultValue", () => {
    expect(parseBoolean(null, { defaultValue: true })).toEqual({ value: true });
  });

  test("passes through boolean true", () => {
    expect(parseBoolean(true)).toEqual({ value: true });
  });

  test("passes through boolean false", () => {
    expect(parseBoolean(false)).toEqual({ value: false });
  });

  test.each([["1"], ["true"], ["yes"], ["TRUE"], ["YES"]])(
    "truthy string %s → true",
    (input) => {
      expect(parseBoolean(input)).toEqual({ value: true });
    }
  );

  test.each([["0"], ["false"], ["no"], ["FALSE"], ["NO"]])(
    "falsy string %s → false",
    (input) => {
      expect(parseBoolean(input)).toEqual({ value: false });
    }
  );

  test("returns error for unrecognised string", () => {
    expect(parseBoolean("maybe", { label: "flag" })).toEqual(
      expect.objectContaining({ error: expect.stringContaining("flag") })
    );
  });
});

// ── parseEnum ─────────────────────────────────────────────────────────────

describe("parseEnum", () => {
  const allowed = ["asc", "desc"];

  test("returns defaultValue when value absent", () => {
    expect(parseEnum(undefined, allowed, { defaultValue: "asc" })).toEqual({ value: "asc" });
  });

  test("returns null default when no defaultValue given", () => {
    expect(parseEnum(undefined, allowed)).toEqual({ value: null });
  });

  test("returns error when required and missing", () => {
    const result = parseEnum(null, allowed, { required: true, label: "sort" });
    expect(result.error).toContain("sort");
  });

  test("accepts a valid enum value (case-insensitive)", () => {
    expect(parseEnum("ASC", allowed)).toEqual({ value: "asc" });
  });

  test("accepts exact lowercase value", () => {
    expect(parseEnum("desc", allowed)).toEqual({ value: "desc" });
  });

  test("returns error for value not in allowed list", () => {
    const result = parseEnum("sideways", allowed, { label: "direction" });
    expect(result.error).toContain("direction");
  });
});

// ── parseSymbol ──────────────────────────────────────────────────────────

describe("parseSymbol", () => {
  test("returns null when value is absent and not required", () => {
    expect(parseSymbol(undefined)).toEqual({ value: null });
  });

  test("returns error when required and missing", () => {
    const result = parseSymbol(null, { required: true });
    expect(result.error).toBeDefined();
  });

  test("normalises value to uppercase", () => {
    expect(parseSymbol("aapl")).toEqual({ value: "AAPL" });
  });

  test("accepts valid ticker symbol", () => {
    expect(parseSymbol("AAPL")).toEqual({ value: "AAPL" });
  });

  test("accepts symbol with dot (e.g. BRK.B)", () => {
    expect(parseSymbol("BRK.B")).toEqual({ value: "BRK.B" });
  });

  test("accepts symbol with hyphen", () => {
    expect(parseSymbol("BF-B")).toEqual({ value: "BF-B" });
  });

  test("rejects symbol with space", () => {
    expect(parseSymbol("A A")).toEqual(
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  test("rejects symbol longer than 20 characters", () => {
    expect(parseSymbol("ABCDEFGHIJKLMNOPQRSTU")).toEqual(
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  test("rejects symbol starting with a dot", () => {
    expect(parseSymbol(".DOT")).toEqual(
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  test("rejects empty string when not required", () => {
    // Empty string counts as no value → returns null (not required)
    expect(parseSymbol("  ")).toEqual({ value: null });
  });

  test("trims whitespace before validation", () => {
    expect(parseSymbol("  MSFT  ")).toEqual({ value: "MSFT" });
  });
});
