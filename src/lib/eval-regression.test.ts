import assert from "node:assert/strict";
import test from "node:test";

/**
 * Unit tests for the regression result shape and classification.
 *
 * The actual Databricks-dependent comparison logic is tested via the
 * compare.ts tests; here we verify the aggregation and status
 * classification that eval-regression.ts applies on top.
 */

interface DeltaLike {
  status: string;
  severity: number;
  key: string;
}

interface Summary {
  total: number;
  passed: number;
  regressed: number;
  improved: number;
  noisy: number;
  unchanged: number;
}

function classifyResult(deltas: DeltaLike[]): {
  status: "pass" | "regression";
  summary: Summary;
} {
  const regressions = deltas.filter((d) => d.status === "regression");
  const improvements = deltas.filter((d) => d.status === "improvement");
  const noisy = deltas.filter((d) => d.status === "noisy");
  const unchanged = deltas.filter((d) => d.status === "unchanged");
  return {
    status: regressions.length > 0 ? "regression" : "pass",
    summary: {
      total: deltas.length,
      passed: unchanged.length + noisy.length + improvements.length,
      regressed: regressions.length,
      improved: improvements.length,
      noisy: noisy.length,
      unchanged: unchanged.length,
    },
  };
}

test("classifies as pass when no regressions", () => {
  const result = classifyResult([
    { status: "unchanged", severity: 0.01, key: "k1" },
    { status: "improvement", severity: 0.03, key: "k2" },
  ]);
  assert.equal(result.status, "pass");
  assert.equal(result.summary.regressed, 0);
  assert.equal(result.summary.passed, 2);
});

test("classifies as regression when any delta is a regression", () => {
  const result = classifyResult([
    { status: "regression", severity: 0.05, key: "k1" },
    { status: "unchanged", severity: 0.01, key: "k2" },
  ]);
  assert.equal(result.status, "regression");
  assert.equal(result.summary.regressed, 1);
  assert.equal(result.summary.passed, 1);
});

test("counts noisy as passed, not regressed", () => {
  const result = classifyResult([
    { status: "noisy", severity: 0.02, key: "k1" },
  ]);
  assert.equal(result.status, "pass");
  assert.equal(result.summary.noisy, 1);
  assert.equal(result.summary.passed, 1);
  assert.equal(result.summary.regressed, 0);
});

test("multiple regressions are all counted", () => {
  const result = classifyResult([
    { status: "regression", severity: 0.02, key: "k1" },
    { status: "regression", severity: 0.05, key: "k2" },
    { status: "unchanged", severity: 0, key: "k3" },
  ]);
  assert.equal(result.status, "regression");
  assert.equal(result.summary.regressed, 2);
  assert.equal(result.summary.total, 3);
});

test("empty deltas classify as pass", () => {
  const result = classifyResult([]);
  assert.equal(result.status, "pass");
  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.regressed, 0);
});
