import useSWR from "swr";
import { formatRelativeTime } from "@/lib/alerts-shared";
import type {
  EvalRegressionSnapshotRow,
  EvalRegressionAlertRow,
} from "@/app/api/alerts/eval/route";

const fetcher = <T,>(url: string): Promise<T> =>
  fetch(url).then((r) => r.json());

interface EvalAlertsResponse {
  alerts?: EvalRegressionAlertRow[];
  snapshots?: EvalRegressionSnapshotRow[];
  schemaStatus?: string;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function fmtDelta(d: number): string {
  const sign = d >= 0 ? "+" : "";
  return `${sign}${(d * 100).toFixed(2)}pp`;
}

export function EvalRegressionBanner() {
  const { data } = useSWR<EvalAlertsResponse>(
    "/api/alerts/eval",
    fetcher,
    { refreshInterval: 5 * 60 * 1000 },
  );

  if (!data || data.schemaStatus === "pending") return null;

  const latestSnapshot = data.snapshots?.[0];
  const openAlerts = (data.alerts ?? []).filter((a) => a.status === "open");

  if (!latestSnapshot) return null;

  const isPass = latestSnapshot.status === "pass";
  const s = latestSnapshot.summary;

  return (
    <div
      className={`rounded-xl border px-5 py-4 ${
        isPass
          ? "border-emerald-200/80 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20"
          : "border-red-200/80 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-lg">
              {isPass ? "✅" : "🚨"}
            </span>
            <h3
              className={`text-sm font-semibold ${
                isPass
                  ? "text-emerald-800 dark:text-emerald-200"
                  : "text-red-800 dark:text-red-200"
              }`}
            >
              {isPass
                ? "All eval checks passed"
                : `${s.regressed} eval regression${s.regressed !== 1 ? "s" : ""} detected`}
            </h3>
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {latestSnapshot.baseline_image} vs {latestSnapshot.candidate_image}
            {" · "}
            checked {formatRelativeTime(latestSnapshot.checked_at)}
            {" · "}
            {s.total} metrics, {s.regressed} regressed, {s.improved} improved
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {latestSnapshot.compare_url && (
            <a
              href={latestSnapshot.compare_url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              View comparison
            </a>
          )}
          <a
            href="/alerts?tab=eval"
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            View alerts
          </a>
        </div>
      </div>

      {/* Show open regressions inline */}
      {openAlerts.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-red-200/60 pt-3 dark:border-red-900/40">
          {openAlerts.slice(0, 5).map((alert) => (
            <div
              key={alert.alert_id}
              className="flex items-center gap-3 text-xs"
            >
              <span className="text-red-500">●</span>
              <span className="font-medium text-zinc-800 dark:text-zinc-200">
                {alert.task}
              </span>
              <span className="text-zinc-500 dark:text-zinc-400">
                {alert.metric}: {fmtPct(alert.baseline_value)} →{" "}
                {fmtPct(alert.candidate_value)}{" "}
                <span className="font-medium text-red-600 dark:text-red-400">
                  ({fmtDelta(alert.delta)}
                  {alert.significance !== null &&
                    `, ${alert.significance.toFixed(1)}σ`}
                  )
                </span>
              </span>
            </div>
          ))}
          {openAlerts.length > 5 && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              … and {openAlerts.length - 5} more
            </p>
          )}
        </div>
      )}
    </div>
  );
}
