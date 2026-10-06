import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { runRegressionCheck, type RegressionResult } from "@/lib/eval-regression";
import { postMessage, updateMessage, addReaction } from "@/lib/slack";
import {
  fmtMetricDelta,
  fmtMetricValue,
  fmtPacificTime,
  fmtSigma,
  getPacificDateKey,
  getPacificTzAbbr,
} from "@/lib/alerts-shared";

export const maxDuration = 55;

/**
 * Parse structured fields from a DeltaItem.key.
 * evalKey in compare.ts joins: model|task|n_shot|metric.name|metric.filter
 */
function parseEvalKey(delta: { key: string; model: string; metric: string }) {
  const parts = delta.key.split("|");
  return {
    model: delta.model,
    task: parts[1] ?? "",
    nShot: parseInt(parts[2] ?? "0", 10),
    metric: delta.metric,
    filter: parts[4] ?? "",
  };
}

function evalAlertKey(fields: { model: string; task: string; nShot: number; metric: string; filter: string }) {
  return `${fields.model}|${fields.task}|${fields.nShot}|${fields.metric}|${fields.filter}`;
}

function slackChannel(): string | null {
  return (
    process.env.SLACK_EVAL_ALERT_CHANNEL ??
    process.env.SLACK_CI_INFRA_ALERT_CHANNEL ??
    process.env.SLACK_CHANNEL_ID ??
    null
  );
}

function buildSlackText(result: RegressionResult, time: string, tz: string): string {
  if (result.status === "pass") {
    return [
      `:white_check_mark: *Eval Regression Check — All Passed*`,
      `${result.candidateLabel} vs baseline ${result.baselineLabel}`,
      `${result.summary.total} metrics checked · 0 regressions`,
      "",
      `_Updated ${time} ${tz}_`,
      `<${result.compareUrl}|View comparison>`,
    ].join("\n");
  }

  const lines = [
    `:rotating_light: *Eval Regression Detected*`,
    `${result.candidateLabel} vs baseline ${result.baselineLabel}`,
    `${result.summary.regressed} regression${result.summary.regressed !== 1 ? "s" : ""} of ${result.summary.total} metrics`,
    "",
  ];
  for (const reg of result.regressions.slice(0, 15)) {
    const fields = parseEvalKey(reg);
    const unit = reg.unit;
    lines.push(
      `:red_circle: *${fields.task}* — ${fields.metric}: ${fmtMetricValue(reg.baselineValue, unit)} → ${fmtMetricValue(reg.candidateValue, unit)} (${fmtMetricDelta(reg.delta, unit)}, ${fmtSigma(reg.significance)})`,
    );
  }
  if (result.regressions.length > 15) {
    lines.push(`… and ${result.regressions.length - 15} more`);
  }
  lines.push("", `_Updated ${time} ${tz}_`);
  lines.push(`<${result.compareUrl}|View comparison>`);
  return lines.join("\n");
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await runRegressionCheck();
    if (!result) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "Could not resolve baseline or candidate image",
      });
    }

    const db = getDb();

    // Persist snapshot (including skipped runs for staleness detection).
    await db`
      INSERT INTO alerting_eval_regression_snapshots
        (baseline_image, candidate_image, status, summary, compare_url, checked_at)
      VALUES (
        ${result.baselineImage},
        ${result.candidateImage},
        ${result.status},
        ${JSON.stringify(result.summary)}::jsonb,
        ${result.compareUrl},
        ${result.checkedAt}
      )
    `;

    // No evidence (skipped) → do not open, resolve, or notify.
    if (result.status === "skipped") {
      return NextResponse.json({
        ok: true,
        status: "skipped",
        reason: "No candidate eval data; no alerts changed",
        baseline: result.baselineImage,
        candidate: result.candidateImage,
      });
    }

    // Upsert regression alerts inside a transaction.
    await db.begin(async (tx) => {
      if (result.status === "regression") {
        for (const reg of result.regressions) {
          const f = parseEvalKey(reg);
          await tx`
            INSERT INTO alerting_eval_regression_alerts
              (model, task, n_shot, metric, filter, higher_is_better, status,
               baseline_image, baseline_value, candidate_image, candidate_value,
               delta, delta_pct, significance)
            VALUES (
              ${f.model}, ${f.task}, ${f.nShot}, ${f.metric}, ${f.filter},
              ${reg.higherIsBetter},
              'open',
              ${result.baselineImage}, ${reg.baselineValue},
              ${result.candidateImage}, ${reg.candidateValue},
              ${reg.delta}, ${reg.deltaPct}, ${reg.significance}
            )
            ON CONFLICT (model, task, n_shot, metric, filter) WHERE status = 'open'
            DO UPDATE SET
              candidate_image = EXCLUDED.candidate_image,
              candidate_value = EXCLUDED.candidate_value,
              delta = EXCLUDED.delta,
              delta_pct = EXCLUDED.delta_pct,
              significance = EXCLUDED.significance,
              updated_at = now()
          `;
        }
      }

      // Resolve alerts that positively passed (not missing).
      const regressionKeys = new Set(
        result.regressions.map((r) => evalAlertKey(parseEvalKey(r))),
      );

      const openAlerts = await tx`
        SELECT alert_id, model, task, n_shot, metric, filter
        FROM alerting_eval_regression_alerts
        WHERE status = 'open'
      `;

      const toResolve = openAlerts
        .filter((a) => {
          const key = `${a.model}|${a.task}|${a.n_shot}|${a.metric}|${a.filter}`;
          return !regressionKeys.has(key);
        })
        .map((a) => a.alert_id);

      if (toResolve.length > 0) {
        await tx`
          UPDATE alerting_eval_regression_alerts
          SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE alert_id = ANY(${toResolve})
        `;
      }
    });

    // Slack notification — only when state changed.
    const channel = slackChannel();
    if (channel && process.env.SLACK_BOT_TOKEN) {
      const time = fmtPacificTime();
      const tz = getPacificTzAbbr();
      const dateKey = getPacificDateKey();

      const summaryRows = await db`
        SELECT message_ts, status FROM alerting_eval_alert_summary
        WHERE id = ${dateKey}
      `;

      const prevMessageTs: string | null =
        summaryRows.length > 0 ? (summaryRows[0].message_ts as string) : null;
      const prevStatus: string | null =
        summaryRows.length > 0 ? (summaryRows[0].status as string) : null;

      const changed = prevStatus !== result.status;

      if (changed || result.status === "regression") {
        const text = buildSlackText(result, time, tz);
        let messageTs = prevMessageTs;

        if (messageTs) {
          const updateResult = await updateMessage(messageTs, text, channel);
          if (!updateResult.ok) {
            console.error("Slack updateMessage failed:", updateResult.error);
          }
          const threadText =
            result.status === "pass"
              ? `:white_check_mark: All eval checks passed`
              : `:rotating_light: ${result.summary.regressed} eval regression${result.summary.regressed !== 1 ? "s" : ""} — updated ${time} ${tz}`;
          const threadResult = await postMessage(threadText, messageTs, channel);
          if (!threadResult.ok) {
            console.error("Slack thread reply failed:", threadResult.error);
          }
        } else {
          const posted = await postMessage(text, undefined, channel);
          if (posted.ok && posted.ts) {
            messageTs = posted.ts;
          } else {
            console.error("Slack postMessage failed:", posted.error);
          }
        }

        if (messageTs) {
          await db`
            INSERT INTO alerting_eval_alert_summary (id, message_ts, status, created_at, updated_at)
            VALUES (${dateKey}, ${messageTs}, ${result.status}, now(), now())
            ON CONFLICT (id) DO UPDATE
              SET message_ts = EXCLUDED.message_ts,
                  status = EXCLUDED.status,
                  updated_at = now()
          `;

          if (result.status === "pass" && changed) {
            const reaction = await addReaction("white_check_mark", messageTs, channel);
            if (!reaction.ok) {
              console.error("Slack addReaction failed:", reaction.error);
            }
          }
        }
      }
    }

    return NextResponse.json({
      ok: true,
      status: result.status,
      baseline: result.baselineImage,
      candidate: result.candidateImage,
      summary: result.summary,
      compareUrl: result.compareUrl,
    });
  } catch (error) {
    console.error("Eval regression check failed:", error);
    return NextResponse.json(
      { error: "Eval regression check failed" },
      { status: 500 },
    );
  }
}
