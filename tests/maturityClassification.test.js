"use strict";

const {
  classifyMaturityPhase,
  HARD_DATA_PROBLEM_RATIO,
  EARLY_PHASE_DOMINANT_RATIO,
} = require("../engines/maturityClassification");

describe("maturityClassification constants", () => {
  test("HARD_DATA_PROBLEM_RATIO is 0.5", () => {
    expect(HARD_DATA_PROBLEM_RATIO).toBe(0.5);
  });

  test("EARLY_PHASE_DOMINANT_RATIO is 0.5", () => {
    expect(EARLY_PHASE_DOMINANT_RATIO).toBe(0.5);
  });
});

describe("classifyMaturityPhase – null / empty inputs", () => {
  test("returns unknown when maturitySummary is null", () => {
    const result = classifyMaturityPhase(null);
    expect(result.phase).toBe("unknown");
    expect(result.total).toBe(0);
  });

  test("returns unknown when maturitySummary is undefined", () => {
    const result = classifyMaturityPhase(undefined);
    expect(result.phase).toBe("unknown");
  });

  test("returns unknown when total is 0", () => {
    const result = classifyMaturityPhase({ total: 0 });
    expect(result.phase).toBe("unknown");
  });

  test("returns unknown when total is missing", () => {
    const result = classifyMaturityPhase({ seed: 5 });
    expect(result.phase).toBe("unknown");
  });

  test("always returns the six numeric fields even for unknown phase", () => {
    const result = classifyMaturityPhase(null);
    expect(result).toMatchObject({
      phase: "unknown",
      earlyPhaseCount: 0,
      devCount: 0,
      matCount: 0,
      hardProblems: 0,
      total: 0,
    });
  });
});

describe("classifyMaturityPhase – hard_problems phase", () => {
  test("triggers hard_problems when hardDataProblems > 50% of total", () => {
    const result = classifyMaturityPhase({ total: 10, hardDataProblems: 6 });
    expect(result.phase).toBe("hard_problems");
  });

  test("exactly at the boundary (>50%) triggers hard_problems", () => {
    const result = classifyMaturityPhase({ total: 10, hardDataProblems: 6 });
    expect(result.phase).toBe("hard_problems");
  });

  test("exactly at 50% does NOT trigger hard_problems", () => {
    const result = classifyMaturityPhase({ total: 10, hardDataProblems: 5 });
    expect(result.phase).not.toBe("hard_problems");
  });

  test("hard_problems takes priority over high early-phase count", () => {
    const result = classifyMaturityPhase({
      total: 10,
      hardDataProblems: 6,
      seed: 5,
      early: 3,
    });
    expect(result.phase).toBe("hard_problems");
  });

  test("returns correct hardProblems value", () => {
    const result = classifyMaturityPhase({ total: 10, hardDataProblems: 7 });
    expect(result.hardProblems).toBe(7);
    expect(result.total).toBe(10);
  });
});

describe("classifyMaturityPhase – early_phase phase", () => {
  test("triggers early_phase when seed+early > 50% of total", () => {
    const result = classifyMaturityPhase({ total: 10, seed: 4, early: 3 });
    expect(result.phase).toBe("early_phase");
  });

  test("exactly at 50% does NOT trigger early_phase", () => {
    const result = classifyMaturityPhase({ total: 10, seed: 3, early: 2 });
    expect(result.phase).not.toBe("early_phase");
  });

  test("returns correct earlyPhaseCount", () => {
    const result = classifyMaturityPhase({ total: 10, seed: 3, early: 4 });
    expect(result.earlyPhaseCount).toBe(7);
  });

  test("early_phase with only seed symbols", () => {
    const result = classifyMaturityPhase({ total: 10, seed: 6 });
    expect(result.phase).toBe("early_phase");
  });

  test("early_phase with only early symbols", () => {
    const result = classifyMaturityPhase({ total: 10, early: 6 });
    expect(result.phase).toBe("early_phase");
  });
});

describe("classifyMaturityPhase – developing phase", () => {
  test("triggers developing when devCount > 0 and no harder condition met", () => {
    const result = classifyMaturityPhase({ total: 10, developing: 3, mature: 7 });
    expect(result.phase).toBe("developing");
  });

  test("returns correct devCount", () => {
    const result = classifyMaturityPhase({ total: 10, developing: 4, mature: 6 });
    expect(result.devCount).toBe(4);
  });

  test("early_phase takes priority over developing", () => {
    const result = classifyMaturityPhase({ total: 10, seed: 6, developing: 4 });
    expect(result.phase).toBe("early_phase");
  });
});

describe("classifyMaturityPhase – unknown fallback", () => {
  test("returns unknown when no problematic condition is met", () => {
    const result = classifyMaturityPhase({ total: 10, mature: 10 });
    expect(result.phase).toBe("unknown");
  });

  test("returns unknown when all counts are zero but total > 0", () => {
    const result = classifyMaturityPhase({ total: 5 });
    expect(result.phase).toBe("unknown");
  });

  test("returns correct matCount", () => {
    const result = classifyMaturityPhase({ total: 10, mature: 8 });
    expect(result.matCount).toBe(8);
  });
});

describe("classifyMaturityPhase – missing fields default to 0", () => {
  test("hardDataProblems defaults to 0 when absent", () => {
    const result = classifyMaturityPhase({ total: 10, mature: 10 });
    expect(result.hardProblems).toBe(0);
  });

  test("seed and early default to 0 when absent", () => {
    const result = classifyMaturityPhase({ total: 10, developing: 3 });
    expect(result.earlyPhaseCount).toBe(0);
  });
});
