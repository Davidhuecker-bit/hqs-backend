"use strict";

const {
  classifyDecisionMaturity,
  getDecisionMaturitySummary,
  VALID_DECISION_MATURITY_BANDS,
} = require("../services/agentBridge.service");

/* ─────────────────────────────────────────────
   Step 13: Decision Maturity / Resolution
   Confidence Light — unit tests
   ───────────────────────────────────────────── */

describe("VALID_DECISION_MATURITY_BANDS", () => {
  test("contains exactly 4 bands", () => {
    expect(VALID_DECISION_MATURITY_BANDS).toHaveLength(4);
  });

  test("includes the expected band names", () => {
    expect(VALID_DECISION_MATURITY_BANDS).toEqual([
      "early_signal",
      "building",
      "credible",
      "confirmed",
    ]);
  });
});

describe("classifyDecisionMaturity – defaults", () => {
  test("returns early_signal with no inputs", () => {
    const result = classifyDecisionMaturity();
    expect(result.decisionMaturityBand).toBe("early_signal");
    expect(result.maturityScore).toBe(0);
    expect(result.maturityDrivers).toEqual([]);
    expect(typeof result.maturityReason).toBe("string");
    expect(result.maturityReason.length).toBeGreaterThan(0);
  });

  test("returns early_signal with empty object", () => {
    const result = classifyDecisionMaturity({});
    expect(result.decisionMaturityBand).toBe("early_signal");
  });
});

describe("classifyDecisionMaturity – early_signal band", () => {
  test("single low-confidence observation stays early_signal", () => {
    const result = classifyDecisionMaturity({
      observationCount: 1,
      confidenceBand: "low",
      readinessBand: "observation",
    });
    expect(result.decisionMaturityBand).toBe("early_signal");
  });

  test("high attention does not automatically elevate maturity", () => {
    const result = classifyDecisionMaturity({
      observationCount: 1,
      attentionBand: "focus_now",
      confidenceBand: "low",
    });
    expect(result.decisionMaturityBand).toBe("early_signal");
  });
});

describe("classifyDecisionMaturity – building band", () => {
  test("repeated observations with medium confidence reach building", () => {
    const result = classifyDecisionMaturity({
      observationCount: 2,
      confidenceBand: "medium",
      readinessBand: "useful_next_step",
    });
    expect(result.decisionMaturityBand).toBe("building");
    expect(result.maturityScore).toBeGreaterThanOrEqual(3);
  });

  test("multiple observations + watching case reach building", () => {
    const result = classifyDecisionMaturity({
      observationCount: 4,
      caseStatus: "watching",
    });
    expect(result.decisionMaturityBand).toBe("building");
  });
});

describe("classifyDecisionMaturity – credible band", () => {
  test("confirmed case + high confidence + mature readiness reach credible", () => {
    const result = classifyDecisionMaturity({
      observationCount: 4,
      confidenceBand: "high",
      readinessBand: "mature_recommendation",
      caseStatus: "confirmed",
    });
    expect(result.decisionMaturityBand).toBe("credible");
    expect(result.maturityScore).toBeGreaterThanOrEqual(6);
  });
});

describe("classifyDecisionMaturity – confirmed band", () => {
  test("full evidence reaches confirmed", () => {
    const result = classifyDecisionMaturity({
      observationCount: 6,
      confidenceBand: "high",
      readinessBand: "mature_recommendation",
      caseStatus: "confirmed",
      helpfulnessBand: "clearly_helpful",
      governancePolicyClass: "guardian_candidate",
    });
    expect(result.decisionMaturityBand).toBe("confirmed");
    expect(result.maturityScore).toBeGreaterThanOrEqual(9);
  });
});

describe("classifyDecisionMaturity – followup penalty", () => {
  test("pending followup reduces maturity score", () => {
    const withFollowup = classifyDecisionMaturity({
      observationCount: 4,
      confidenceBand: "medium",
      readinessBand: "useful_next_step",
      needsFollowup: true,
    });
    const withoutFollowup = classifyDecisionMaturity({
      observationCount: 4,
      confidenceBand: "medium",
      readinessBand: "useful_next_step",
      needsFollowup: false,
    });
    expect(withFollowup.maturityScore).toBeLessThan(withoutFollowup.maturityScore);
    expect(withFollowup.maturityDrivers).toContain("followup_pending");
  });
});

describe("classifyDecisionMaturity – separation from other dimensions", () => {
  test("high attention + early_signal maturity is valid (deliberate separation)", () => {
    const result = classifyDecisionMaturity({
      observationCount: 1,
      confidenceBand: "low",
      attentionBand: "focus_now",
    });
    expect(result.decisionMaturityBand).toBe("early_signal");
  });

  test("high issue severity alone does not elevate maturity", () => {
    const result = classifyDecisionMaturity({
      issueSeverity: "high",
      observationCount: 0,
    });
    expect(result.decisionMaturityBand).toBe("early_signal");
  });

  test("resolved case contributes to maturity even with low confidence", () => {
    const result = classifyDecisionMaturity({
      caseStatus: "resolved",
      confidenceBand: "low",
      observationCount: 2,
    });
    expect(result.maturityDrivers).toContain("case_resolved");
    expect(result.maturityScore).toBeGreaterThanOrEqual(3);
  });
});

describe("classifyDecisionMaturity – maturity reason format", () => {
  test("reason contains cooperative language (no alarm/hype)", () => {
    const result = classifyDecisionMaturity({
      observationCount: 4,
      confidenceBand: "high",
      caseStatus: "confirmed",
    });
    expect(result.maturityReason).not.toMatch(/alarm|gefahr|dringend|sofort/i);
    expect(result.maturityReason).toMatch(/–/); // contains em-dash separator
  });

  test("early_signal reason includes band label", () => {
    const result = classifyDecisionMaturity();
    expect(result.maturityReason).toContain("Frühes Signal");
  });

  test("confirmed reason includes band label", () => {
    const result = classifyDecisionMaturity({
      observationCount: 6,
      confidenceBand: "high",
      readinessBand: "mature_recommendation",
      caseStatus: "resolved",
      helpfulnessBand: "clearly_helpful",
      governancePolicyClass: "admin_visible",
    });
    expect(result.maturityReason).toContain("Belastbar bestätigt");
  });
});

describe("classifyDecisionMaturity – driver tracking", () => {
  test("tracks observation drivers correctly", () => {
    const result = classifyDecisionMaturity({
      observationCount: 6,
    });
    expect(result.maturityDrivers).toContain("observations_substantial");
  });

  test("tracks confidence driver", () => {
    const result = classifyDecisionMaturity({
      confidenceBand: "high",
    });
    expect(result.maturityDrivers).toContain("confidence_high");
  });

  test("tracks readiness driver", () => {
    const result = classifyDecisionMaturity({
      readinessBand: "mature_recommendation",
    });
    expect(result.maturityDrivers).toContain("readiness_mature");
  });

  test("tracks governance driver", () => {
    const result = classifyDecisionMaturity({
      governancePolicyClass: "guardian_candidate",
    });
    expect(result.maturityDrivers).toContain("governance_guardian");
  });
});

describe("getDecisionMaturitySummary", () => {
  test("returns a summary object with expected fields", () => {
    const summary = getDecisionMaturitySummary();
    expect(summary).toHaveProperty("totalPatterns");
    expect(summary).toHaveProperty("totalCases");
    expect(summary).toHaveProperty("bandDistribution");
    expect(summary).toHaveProperty("driverFrequency");
    expect(summary).toHaveProperty("readinessVsMaturity");
    expect(summary).toHaveProperty("caseVsMaturity");
    expect(summary).toHaveProperty("attentionVsMaturity");
    expect(summary).toHaveProperty("highMaturityEntries");
    expect(summary).toHaveProperty("earlyDespiteAttention");
    expect(summary).toHaveProperty("generatedAt");
    expect(typeof summary.totalPatterns).toBe("number");
    expect(typeof summary.generatedAt).toBe("string");
  });

  test("bandDistribution contains all four bands", () => {
    const summary = getDecisionMaturitySummary();
    expect(summary.bandDistribution).toHaveProperty("early_signal");
    expect(summary.bandDistribution).toHaveProperty("building");
    expect(summary.bandDistribution).toHaveProperty("credible");
    expect(summary.bandDistribution).toHaveProperty("confirmed");
  });

  test("highMaturityEntries and earlyDespiteAttention are arrays", () => {
    const summary = getDecisionMaturitySummary();
    expect(Array.isArray(summary.highMaturityEntries)).toBe(true);
    expect(Array.isArray(summary.earlyDespiteAttention)).toBe(true);
  });
});
