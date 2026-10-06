# Eval regression alerts

## What it detects

A sigma-based regression in lm_eval or BFCL accuracy metrics between the
latest **nightly** image (candidate) and the latest **release** image
(baseline).  Each metric is keyed by `model | task | n_shot | metric_name
| filter`.

The baseline is dynamic — resolved from Databricks by picking the newest
release image that has eval data (`classifyImage` → `groupImagesByKind`).

When no candidate data exists (`total === 0` or `missingCandidate > 0`),
the run is recorded as **skipped**: no alerts are opened, resolved, or
notified.  This prevents false all-clear messages.

## Where the code lives

- `src/lib/eval-regression.ts` — core logic.  `classifyDeltas()` is a
  pure function (tested); `runRegressionCheck()` orchestrates a single
  Databricks load, baseline resolution, comparison, and threshold check.
- `src/lib/eval-baseline.ts` — dynamic baseline resolution.  All functions
  accept a pre-loaded row set so the cron path avoids redundant scans.
- `src/app/api/cron/eval-regression/route.ts` — cron endpoint: auth →
  regression check → persist snapshot → upsert/resolve alerts in a
  transaction → Slack notification on state change.
- `src/app/api/eval/baseline/route.ts` — `GET /api/eval/baseline` returns
  the resolved baseline image and metadata (no full metrics payload).
- `src/app/api/alerts/eval/route.ts` — reads alerts and snapshots for the
  UI.
- `src/components/eval-alerts.tsx` — alert list with open/resolved
  sections and recent-checks history.
- `src/components/eval-regression-banner.tsx` — status banner on the Eval
  page showing pass/regression/skipped/stale states.
- `src/lib/eval-regression.test.ts` — unit tests for `classifyDeltas`.
- Schedule: Vercel cron in `vercel.json` hits `/api/cron/eval-regression`
  every 6 hours (`0 */6 * * *`).

## Configuration

- `SLACK_BOT_TOKEN` — the bot token for posting.
- `SLACK_EVAL_ALERT_CHANNEL` — preferred channel; falls back to
  `SLACK_CI_INFRA_ALERT_CHANNEL`, then `SLACK_CHANNEL_ID`.
- `CRON_SECRET` — when set, the route requires `Authorization: Bearer`.
- `DASHBOARD_BASE_URL` — base URL for compare links (defaults to
  `https://ci.vllm.ai`).

Sigma threshold is passed as a parameter (default 2σ) and is not stored in
a thresholds table.

## What it posts to Slack

One combined message per Pacific day (keyed by `alerting_eval_alert_summary.id`).
On each run with a state change the route either posts the day's message or
edits it in place, then adds a thread reply so the channel gets a
notification.

- **Regression**: `:rotating_light:` header listing up to 15 regressed
  metrics with baseline → candidate values, delta, and sigma.
- **Pass**: `:white_check_mark:` header with total metrics checked.
- **Resolved**: When a regression clears, a ✅ reaction is added to the
  day message.

Skipped runs produce no Slack activity.

## Integration with perf-eval (Buildkite)

A thin `compare_via_api.py` in the perf-eval repo calls `/api/eval/baseline`
to discover the baseline image, then `/api/compare` to get the comparison.
It prints a formatted table to the Buildkite log and exits:

- `0` — all metrics passed
- `1` — regression detected (fails the Buildkite step)
- `2` — API unreachable (warning only, does not fail)

## Tables

All tables use the `alerting_` prefix (migration `0023`).

- `alerting_eval_regression_alerts` — one row per open or resolved alert
  episode.  Unique constraint on `(model, task, n_shot, metric, filter)
  WHERE status = 'open'` ensures one open episode per eval key.
- `alerting_eval_regression_snapshots` — one row per cron run (including
  skipped).  Retained for 30 days (see retention cron).
- `alerting_eval_alert_summary` — one row per Pacific day: Slack message
  ts and latest status.  Used for edit-in-place and reaction logic.

## Dashboard views

- `/alerts` → "Eval regressions" tab shows open/resolved alerts and recent
  check history.
- `/eval` → `<EvalRegressionBanner />` shows current pass/regression/
  skipped/stale status with a staleness threshold of 7 hours.
