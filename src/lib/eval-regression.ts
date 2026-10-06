/**
 * Eval regression detection.
 *
 * Compares the latest nightly eval results against a dynamic baseline
 * (latest release image) and classifies each metric as pass, regression,
 * improvement, noisy, or missing.
 */

import { loadEvalRows } from "@/lib/eval-data";
import { compareEvalRows, type DeltaItem } from "@/lib/compare";
import {
  resolveEvalBaseline,
  resolveLatestNightlyImage,
  type EvalBaseline,
} from "@/lib/eval-baseline";
import { describeImage } from "@/lib/commit-from-image";

export type RegressionStatus = "pass" | "regression";

export interface EvalRegressionResult {
  status: RegressionStatus;
  baselineImage: string;
  baselineLabel: string;
  candidateImage: string;
  candidateLabel: string;
  evalSigma: number;
  checkedAt: string;
  summary: {
    total: number;
    passed: number;
    regressed: number;
    improved: number;
    noisy: number;
    unchanged: number;
    missingBaseline: number;
    missingCandidate: number;
  };
  regressions: DeltaItem[];
  improvements: DeltaItem[];
  allDeltas: DeltaItem[];
  compareUrl: string;
}

function buildCompareUrl(
  dashboardUrl: string,
  baseline: string,
  candidate: string,
): string {
  const params = new URLSearchParams({ baseline, candidate });
  return `${dashboardUrl}/compare?${params.toString()}`;
}

export interface RunRegressionCheckOpts {
  /** Explicit baseline image; auto-resolves to latest release when omitted. */
  baselineImage?: string | null;
  /** Explicit candidate image; auto-resolves to latest nightly when omitted. */
  candidateImage?: string | null;
  /** Sigma threshold for eval regression classification.  Default: 2. */
  evalSigma?: number;
  /** Dashboard base URL for compare links.  Default: https://ci.vllm.ai */
  dashboardUrl?: string;
}

/**
 * Run a full regression check: resolve baseline and candidate, load eval
 * rows for both, compare, and classify.
 *
 * Returns null when baseline or candidate cannot be resolved.
 */
export async function runRegressionCheck(
  opts: RunRegressionCheckOpts = {},
): Promise<EvalRegressionResult | null> {
  const evalSigma = opts.evalSigma ?? 2;
  const dashboardUrl = opts.dashboardUrl ?? "https://ci.vllm.ai";

  const baseline: EvalBaseline | null = await resolveEvalBaseline(
    opts.baselineImage,
  );
  if (!baseline) return null;

  const candidateImage =
    opts.candidateImage || (await resolveLatestNightlyImage());
  if (!candidateImage) return null;

  if (candidateImage === baseline.baselineImage) return null;

  const evalRows = await loadEvalRows({
    images: [baseline.baselineImage, candidateImage],
  });

  const evalResult = compareEvalRows(
    evalRows,
    baseline.baselineImage,
    candidateImage,
    evalSigma,
  );

  const regressions = evalResult.deltas.filter(
    (d) => d.status === "regression",
  );
  const improvements = evalResult.deltas.filter(
    (d) => d.status === "improvement",
  );
  const noisy = evalResult.deltas.filter((d) => d.status === "noisy");
  const unchanged = evalResult.deltas.filter((d) => d.status === "unchanged");

  const status: RegressionStatus =
    regressions.length > 0 ? "regression" : "pass";

  return {
    status,
    baselineImage: baseline.baselineImage,
    baselineLabel: describeImage(baseline.baselineImage),
    candidateImage,
    candidateLabel: describeImage(candidateImage),
    evalSigma,
    checkedAt: new Date().toISOString(),
    summary: {
      total: evalResult.deltas.length,
      passed:
        unchanged.length + noisy.length + improvements.length,
      regressed: regressions.length,
      improved: improvements.length,
      noisy: noisy.length,
      unchanged: unchanged.length,
      missingBaseline: evalResult.missingBaseline.length,
      missingCandidate: evalResult.missingCandidate.length,
    },
    regressions: regressions.sort((a, b) => b.severity - a.severity),
    improvements: improvements.sort((a, b) => b.severity - a.severity),
    allDeltas: evalResult.deltas,
    compareUrl: buildCompareUrl(
      dashboardUrl,
      baseline.baselineImage,
      candidateImage,
    ),
  };
}
