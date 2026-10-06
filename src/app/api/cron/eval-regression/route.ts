import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { runRegressionCheck } from "@/lib/eval-regression";
import { postMessage, updateMessage, addReaction } from "@/lib/slack";

export const maxDuration = 55;

function slackChannel(): string | null {
  return (
    process.env.SLACK_EVAL_ALERT_CHANNEL ??
    process.env.SLACK_CI_INFRA_ALERT_CHANNEL ??
    process.env.SLACK_CHANNEL_ID ??
    null
  );
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function fmtDelta(d: number): string {
  const sign = d >= 0 ? "+" : "";
  return `${sign}${(d * 100).toFixed(2)}pp`;
}

function fmtSigma(s: number | null): string {
  return s !== null ? `${s.toFixed(1)}σ` : "";
}

function getPacificTzAbbr(): string {
  const abbr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "short",
  })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName");
  return abbr?.value ?? "PT";
}

function fmtTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Los_Angeles",
  });
}

function getPacificDateKey(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
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

    // Persist the snapshot.
    await db`
      INSERT INTO eval_regression_snapshots
        (baseline_image, candidate_image, status, summary, regressions, compare_url, checked_at)
      VALUES (
        ${result.baselineImage},
        ${result.candidateImage},
        ${result.status},
        ${JSON.stringify(result.summary)}::jsonb,
        ${JSON.stringify(result.regressions)}::jsonb,
        ${result.compareUrl},
        ${result.checkedAt}
      )
    `;

    // Update alert episodes.
    if (result.status === "regression") {
      for (const reg of result.regressions) {
        await db`
          INSERT INTO eval_regression_alerts
            (model, task, metric, filter, status,
             baseline_image, baseline_value, candidate_image, candidate_value,
             delta, delta_pct, significance)
          VALUES (
            ${reg.model}, ${reg.dimension.split(" - ")[0]},
            ${reg.metric}, ${reg.metricLabel},
            'open',
            ${result.baselineImage}, ${reg.baselineValue},
            ${result.candidateImage}, ${reg.candidateValue},
            ${reg.delta}, ${reg.deltaPct}, ${reg.significance}
          )
          ON CONFLICT (model, task, metric, filter) WHERE status = 'open'
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

    // Resolve alerts for metrics that are no longer regressing.
    const regressionKeys = new Set(
      result.regressions.map(
        (r) => `${r.model}|${r.dimension.split(" - ")[0]}|${r.metric}|${r.metricLabel}`,
      ),
    );
    const openAlerts = await db`
      SELECT alert_id, model, task, metric, filter
      FROM eval_regression_alerts
      WHERE status = 'open'
    `;
    for (const alert of openAlerts) {
      const key = `${alert.model}|${alert.task}|${alert.metric}|${alert.filter}`;
      if (!regressionKeys.has(key)) {
        await db`
          UPDATE eval_regression_alerts
          SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE alert_id = ${alert.alert_id}
        `;
      }
    }

    // Slack notification.
    const channel = slackChannel();
    if (channel && process.env.SLACK_BOT_TOKEN) {
      const time = fmtTime();
      const tz = getPacificTzAbbr();
      const dateKey = getPacificDateKey();

      let text: string;
      if (result.status === "pass") {
        const lines = [
          `:white_check_mark: *Eval Regression Check — All Passed*`,
          `${result.candidateLabel} vs baseline ${result.baselineLabel}`,
          `${result.summary.total} metrics checked · 0 regressions`,
          "",
          `_Updated ${time} ${tz}_`,
          `<${result.compareUrl}|View comparison>`,
        ];
        text = lines.join("\n");
      } else {
        const lines = [
          `:rotating_light: *Eval Regression Detected*`,
          `${result.candidateLabel} vs baseline ${result.baselineLabel}`,
          `${result.summary.regressed} regression${result.summary.regressed !== 1 ? "s" : ""} of ${result.summary.total} metrics`,
          "",
        ];
        for (const reg of result.regressions.slice(0, 15)) {
          const task = reg.dimension.split(" - ")[0];
          lines.push(
            `:red_circle: *${task}* — ${reg.metric}: ${fmtPct(reg.baselineValue)} → ${fmtPct(reg.candidateValue)} (${fmtDelta(reg.delta)}, ${fmtSigma(reg.significance)})`,
          );
        }
        if (result.regressions.length > 15) {
          lines.push(
            `… and ${result.regressions.length - 15} more`,
          );
        }
        lines.push("", `_Updated ${time} ${tz}_`);
        lines.push(`<${result.compareUrl}|View comparison>`);
        text = lines.join("\n");
      }

      // Reuse today's message if one exists.
      const summaryRows = await db`
        SELECT message_ts FROM eval_alert_summary WHERE id = ${dateKey}
      `.catch(() => []);

      let messageTs: string | null =
        summaryRows.length > 0
          ? (summaryRows[0].message_ts as string)
          : null;

      if (messageTs) {
        await updateMessage(messageTs, text);
        const threadText =
          result.status === "pass"
            ? `:white_check_mark: All eval checks passed`
            : `:rotating_light: ${result.summary.regressed} eval regression${result.summary.regressed !== 1 ? "s" : ""} — updated ${time} ${tz}`;
        await postMessage(threadText, messageTs, channel);
      } else {
        const posted = await postMessage(text, undefined, channel);
        if (posted.ok && posted.ts) {
          messageTs = posted.ts;
        }
      }

      if (messageTs) {
        await db`
          INSERT INTO eval_alert_summary (id, message_ts, created_at, updated_at)
          VALUES (${dateKey}, ${messageTs}, now(), now())
          ON CONFLICT (id) DO UPDATE
            SET message_ts = EXCLUDED.message_ts, updated_at = now()
        `.catch(() => {});

        if (result.status === "pass") {
          await addReaction("white_check_mark", messageTs).catch(() => {});
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
