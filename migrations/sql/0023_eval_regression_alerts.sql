-- Eval regression alert episodes.
--
-- Each row tracks one regression episode for a (model, task, metric, filter)
-- combination.  An episode opens when a nightly result regresses beyond the
-- sigma threshold relative to the baseline, and resolves when a later check
-- shows the metric has recovered.

CREATE TABLE IF NOT EXISTS eval_regression_alerts (
    alert_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model               text NOT NULL,
    task                text NOT NULL,
    metric              text NOT NULL,
    filter              text NOT NULL,
    status              text NOT NULL CHECK (status IN ('open', 'resolved')),
    baseline_image      text NOT NULL,
    baseline_value      double precision NOT NULL,
    candidate_image     text NOT NULL,
    candidate_value     double precision NOT NULL,
    delta               double precision NOT NULL,
    delta_pct           double precision,
    significance        double precision,
    opened_at           timestamptz NOT NULL DEFAULT now(),
    resolved_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Only one open alert per (model, task, metric, filter).
CREATE UNIQUE INDEX IF NOT EXISTS eval_regression_alerts_open_idx
    ON eval_regression_alerts (model, task, metric, filter)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS eval_regression_alerts_history_idx
    ON eval_regression_alerts (
        status, COALESCE(resolved_at, opened_at) DESC
    );

-- Snapshot of each cron comparison run for history and debugging.
CREATE TABLE IF NOT EXISTS eval_regression_snapshots (
    snapshot_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    baseline_image      text NOT NULL,
    candidate_image     text NOT NULL,
    status              text NOT NULL CHECK (status IN ('pass', 'regression')),
    summary             jsonb NOT NULL,
    regressions         jsonb NOT NULL DEFAULT '[]'::jsonb,
    compare_url         text,
    slack_message_ts    text,
    checked_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eval_regression_snapshots_checked_idx
    ON eval_regression_snapshots (checked_at DESC);

-- Daily Slack message tracking (one consolidated message per Pacific day,
-- updated in place like queue alerts).
CREATE TABLE IF NOT EXISTS eval_alert_summary (
    id              text PRIMARY KEY,
    message_ts      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Row-level security: prevent Supabase public API roles from accessing these
-- tables directly.
ALTER TABLE public.eval_regression_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_regression_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
    protected_tables constant text :=
        'public.eval_regression_alerts, '
        'public.eval_regression_snapshots, '
        'public.eval_alert_summary';
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I',
                protected_tables,
                api_role
            );
        END IF;
    END LOOP;
END;
$$;
