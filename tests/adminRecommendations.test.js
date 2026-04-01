"use strict";

const {
  buildAdminRecommendations,
  resolveSystemStatusText,
  resolveTrustStatusText,
  resolveScalingStatusText,
  resolveExpansionStatusText,
} = require("../engines/adminRecommendations.engine");

// ── resolveSystemStatusText ───────────────────────────────────────────────

describe("resolveSystemStatusText", () => {
  test("excellent → strong/stable message", () => {
    expect(resolveSystemStatusText("excellent")).toMatch(/sehr stark/i);
  });

  test("good → stable message", () => {
    expect(resolveSystemStatusText("good")).toMatch(/stabil/i);
  });

  test("critical → critical message", () => {
    expect(resolveSystemStatusText("critical")).toMatch(/kritisch/i);
  });

  test("unknown band → fallback message", () => {
    const result = resolveSystemStatusText("warning");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("undefined band → fallback message", () => {
    const result = resolveSystemStatusText(undefined);
    expect(typeof result).toBe("string");
  });
});

// ── resolveTrustStatusText ────────────────────────────────────────────────

describe("resolveTrustStatusText", () => {
  test("trusted band", () => {
    expect(resolveTrustStatusText("trusted")).toMatch(/belastbar/i);
  });

  test("usable band", () => {
    expect(resolveTrustStatusText("usable")).toMatch(/brauchbar/i);
  });

  test("unreliable band", () => {
    expect(resolveTrustStatusText("unreliable")).toMatch(/verlässlich/i);
  });

  test("unknown band → fallback string", () => {
    const result = resolveTrustStatusText("thin");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── resolveScalingStatusText ──────────────────────────────────────────────

describe("resolveScalingStatusText", () => {
  test("scale600 allowed → mentions 600", () => {
    expect(resolveScalingStatusText(true, true)).toMatch(/600/);
  });

  test("only scale450 allowed → mentions 450", () => {
    expect(resolveScalingStatusText(false, true)).toMatch(/450/);
  });

  test("neither allowed → stabilise message", () => {
    const result = resolveScalingStatusText(false, false);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("scale600 takes priority over scale450", () => {
    const bothTrue = resolveScalingStatusText(true, true);
    const onlyScale600 = resolveScalingStatusText(true, false);
    expect(bothTrue).toBe(onlyScale600);
  });
});

// ── resolveExpansionStatusText ────────────────────────────────────────────

describe("resolveExpansionStatusText", () => {
  test("china → china message", () => {
    expect(resolveExpansionStatusText("china")).toMatch(/china/i);
  });

  test("europe → europe message", () => {
    expect(resolveExpansionStatusText("europe")).toMatch(/europa/i);
  });

  test("us_broader_universe → US message", () => {
    expect(resolveExpansionStatusText("us_broader_universe")).toMatch(/US/i);
  });

  test("unknown value → fallback string", () => {
    const result = resolveExpansionStatusText("other");
    expect(typeof result).toBe("string");
  });
});

// ── buildAdminRecommendations ─────────────────────────────────────────────

describe("buildAdminRecommendations", () => {
  test("returns object with expected keys", () => {
    const result = buildAdminRecommendations();
    expect(result).toHaveProperty("generatedAt");
    expect(result).toHaveProperty("topBottleneckTitle");
    expect(result).toHaveProperty("nextActions");
    expect(result).toHaveProperty("warnings");
    expect(result).toHaveProperty("opportunities");
  });

  test("generatedAt is a valid ISO date string", () => {
    const result = buildAdminRecommendations();
    expect(() => new Date(result.generatedAt)).not.toThrow();
    expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
  });

  test("nextActions contains up to 3 items from tuning targets", () => {
    const payload = {
      tuning: {
        topTuningTargets: [
          { title: "Action 1" },
          { title: "Action 2" },
          { title: "Action 3" },
          { title: "Action 4" },
        ],
      },
    };
    const result = buildAdminRecommendations(payload);
    expect(result.nextActions).toHaveLength(3);
    expect(result.nextActions[0]).toBe("Action 1");
  });

  test("nextActions is empty when no tuning targets", () => {
    const result = buildAdminRecommendations({});
    expect(result.nextActions).toEqual([]);
  });

  test("warnings comes from diagnostics.warnings (max 3)", () => {
    const payload = {
      diagnostics: {
        warnings: [
          { title: "W1", detail: "d1" },
          { title: "W2", detail: "d2" },
          { title: "W3", detail: "d3" },
          { title: "W4", detail: "d4" },
        ],
      },
    };
    const result = buildAdminRecommendations(payload);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toEqual({ title: "W1", detail: "d1" });
  });

  test("opportunities comes from diagnostics.opportunities (max 3)", () => {
    const payload = {
      diagnostics: {
        opportunities: [
          { title: "O1", detail: "d1" },
          { title: "O2", detail: "d2" },
          { title: "O3", detail: "d3" },
          { title: "O4", detail: "d4" },
        ],
      },
    };
    const result = buildAdminRecommendations(payload);
    expect(result.opportunities).toHaveLength(3);
  });

  test("topBottleneckTitle falls back to default string when absent", () => {
    const result = buildAdminRecommendations({});
    expect(result.topBottleneckTitle).toBe("Kein klarer Engpass erkannt");
  });

  test("topBottleneckTitle uses provided value", () => {
    const payload = {
      diagnostics: {
        summary: { topBottleneckTitle: "Snapshot Pipeline" },
      },
    };
    const result = buildAdminRecommendations(payload);
    expect(result.topBottleneckTitle).toBe("Snapshot Pipeline");
  });

  test("called with no arguments returns valid structure", () => {
    expect(() => buildAdminRecommendations()).not.toThrow();
    const result = buildAdminRecommendations();
    expect(Array.isArray(result.nextActions)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.opportunities)).toBe(true);
  });
});
