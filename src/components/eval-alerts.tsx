import { formatAlertDateTime, formatRelativeTime } from "@/lib/alerts-shared";
import type {
  EvalRegressionAlertRow,
  EvalRegressionSnapshotRow,
} from "@/app/api/alerts/eval/route";

function StatusBadge({ status }: { status: "open" | "resolved" }) {
  return status === "open" ? (
    <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/60 dark:text-red-300">
      Open
    </span>
  ) : (
    <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      Resolved
    </span>
  );
}

function CheckStatusBadge({ status }: { status: "pass" | "regression" }) {
  return status === "pass" ? (
    <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
      Pass
    </span>
  ) : (
    <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/60 dark:text-red-300">
      Regression
    </span>
  );
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function fmtDelta(d: number): string {
  const sign = d >= 0 ? "+" : "";
  return `${sign}${(d * 100).toFixed(2)}pp`;
}

function AlertRow({ alert }: { alert: EvalRegressionAlertRow }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            {alert.task}
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {alert.metric}
          </span>
          <StatusBadge status={alert.status} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="font-mono">{alert.model}</span>
          <span>
            {fmtPct(alert.baseline_value)} → {fmtPct(alert.candidate_value)}{" "}
            <span
              className={
                alert.delta < 0
                  ? "font-medium text-red-600 dark:text-red-400"
                  : "font-medium text-emerald-600 dark:text-emerald-400"
              }
            >
              ({fmtDelta(alert.delta)}
              {alert.significance !== null &&
                `, ${alert.significance.toFixed(1)}σ`}
              )
            </span>
          </span>
        </div>
      </div>
      <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
        Opened {formatAlertDateTime(alert.opened_at)}
        {alert.resolved_at &&
          ` · Resolved ${formatAlertDateTime(alert.resolved_at)}`}
      </span>
    </li>
  );
}

function SnapshotRow({ snapshot }: { snapshot: EvalRegressionSnapshotRow }) {
  const s = snapshot.summary;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm sm:px-5">
      <CheckStatusBadge status={snapshot.status} />
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        {s.total} metrics · {s.regressed} regressed · {s.improved} improved
      </span>
      <span className="ml-auto shrink-0 font-mono text-xs text-zinc-400">
        {formatRelativeTime(snapshot.checked_at)}
      </span>
      {snapshot.compare_url && (
        <a
          href={snapshot.compare_url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          View
        </a>
      )}
    </li>
  );
}

export function EvalAlerts({
  alerts,
  snapshots,
}: {
  alerts: EvalRegressionAlertRow[];
  snapshots: EvalRegressionSnapshotRow[];
}) {
  const openAlerts = alerts.filter((a) => a.status === "open");
  const resolvedAlerts = alerts.filter((a) => a.status === "resolved");

  return (
    <div className="space-y-4">
      {/* Latest check result */}
      {snapshots.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-4 py-3 sm:px-5 dark:border-zinc-800">
            <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              Recent checks
            </h3>
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {snapshots.map((snap) => (
              <SnapshotRow key={snap.snapshot_id} snapshot={snap} />
            ))}
          </ul>
        </div>
      )}

      {/* Open regressions */}
      <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 px-4 py-3 sm:px-5 dark:border-zinc-800">
          <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Open regressions ({openAlerts.length})
          </h3>
        </div>
        {openAlerts.length === 0 ? (
          <p className="px-4 py-5 text-sm text-zinc-500 sm:px-5 dark:text-zinc-400">
            No open eval regressions.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {openAlerts.map((alert) => (
              <AlertRow key={alert.alert_id} alert={alert} />
            ))}
          </ul>
        )}
      </div>

      {/* Recently resolved */}
      {resolvedAlerts.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-4 py-3 sm:px-5 dark:border-zinc-800">
            <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              Recently resolved ({resolvedAlerts.length})
            </h3>
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {resolvedAlerts.map((alert) => (
              <AlertRow key={alert.alert_id} alert={alert} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
