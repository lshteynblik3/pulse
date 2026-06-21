-- Pulse — Phase 5, migration 0011: the insights table.
-- Apply in the Supabase SQL editor AFTER 0010_insight_batches.sql.
--
-- Stores the LLM-generated coaching insights (the collect cron writes here). One
-- row per insight; 2–3 rows per (user, date). Per SPEC: id, user_id, date, type,
-- title, body, created_at.
--
-- "An LLM produced this": ONLY successful, schema-valid model output is stored.
-- Free users and per-user LLM failures get computed tips at READ time and are
-- NEVER persisted — so a row's existence means "the model coached this day."
--
-- Idempotency is delete-then-insert per (user_id, date) in the collect cron, so
-- there is deliberately NO unique constraint on (user_id, date) (2–3 rows share
-- it) — the index below serves both the dashboard read and the delete.
--
-- RLS: users read their OWN insights (the dashboard reads under the session
-- client). Writes are service-role only (the collect cron) — no insert/update/
-- delete policy, mirroring daily_summaries.
--
-- Idempotent: create-if-not-exists for the table/index, and the policy is created
-- inside a guard so re-pasting the whole migration is safe.

create table if not exists insights (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  date        date not null,                       -- the user's LOCAL day
  type        text not null
    check (type in ('peak-window', 'meeting-load', 'streak')),
  title       text not null,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists insights_user_date_idx on insights (user_id, date);

alter table insights enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'insights' and policyname = 'Users read own insights'
  ) then
    create policy "Users read own insights"
      on insights for select
      to authenticated
      using (user_id = auth.uid());
  end if;
end $$;
-- No insert/update/delete policy: only the service-role collect cron writes here.
