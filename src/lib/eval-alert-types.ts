/** Shared types for eval regression alerts, used by the API route and UI. */

export interface EvalRegressionAlert {
  alert_id: number;
  model: string;
  task: string;
  n_shot: number;
  metric: string;
  filter: string;
  higher_is_better: boolean;
  status: "open" | "resolved";
  baseline_image: string;
  baseline_value: number;
  candidate_image: string;
  candidate_value: number;
  delta: number;
  delta_pct: number | null;
  significance: number | null;
  opened_at: string;
  resolved_at: string | null;
}

export interface EvalRegressionSnapshot {
  snapshot_id: number;
  baseline_image: string;
  candidate_image: string;
  status: "pass" | "regression" | "skipped" | "error";
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
  compare_url: string | null;
  checked_at: string;
}
