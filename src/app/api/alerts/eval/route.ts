import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";

export const dynamic = "force-dynamic";

const MAX_ALERTS = 200;
const MAX_SNAPSHOTS = 20;

export interface EvalRegressionAlertRow {
  alert_id: number;
  model: string;
  task: string;
  metric: string;
  filter: string;
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

export interface EvalRegressionSnapshotRow {
  snapshot_id: number;
  baseline_image: string;
  candidate_image: string;
  status: "pass" | "regression";
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
  regressions: unknown[];
  compare_url: string | null;
  checked_at: string;
}

export async function GET() {
  try {
    const db = getDb();

    const [alerts, snapshots] = await Promise.all([
      db<EvalRegressionAlertRow[]>`
        SELECT alert_id, model, task, metric, filter, status,
               baseline_image, baseline_value,
               candidate_image, candidate_value,
               delta, delta_pct, significance,
               opened_at, resolved_at
        FROM eval_regression_alerts
        WHERE status = 'open'
           OR resolved_at >= now() - interval '30 days'
        ORDER BY (status = 'open') DESC,
                 COALESCE(resolved_at, opened_at) DESC
        LIMIT ${MAX_ALERTS}
      `,
      db<EvalRegressionSnapshotRow[]>`
        SELECT snapshot_id, baseline_image, candidate_image,
               status, summary, regressions, compare_url, checked_at
        FROM eval_regression_snapshots
        ORDER BY checked_at DESC
        LIMIT ${MAX_SNAPSHOTS}
      `,
    ]);

    return NextResponse.json(
      { alerts, snapshots, schemaStatus: "ready" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (hasPostgresErrorCode(error, "42P01")) {
      return NextResponse.json(
        { alerts: [], snapshots: [], schemaStatus: "pending" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("Failed to load eval regression alerts:", error);
    return NextResponse.json(
      { error: "Eval regression alerts could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
