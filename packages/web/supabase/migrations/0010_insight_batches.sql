-- Pulse — Phase 5, migration 0010: the insight-batch tracking table.
-- Apply in the Supabase SQL editor AFTER 0009_users_is_paid.sql.
--
-- The AI insights worker is split into two crons to dodge Vercel function
-- timeouts: a nightly SUBMIT step builds payloads and submits ONE Anthropic
-- Message Batch, and a later COLLECT step fetches finished results. This row is
-- the bridge between them — it records the submitted batch so collect can find
-- it, key off its status, and not rescan a batch forever.
--
-- The (user_id, date) pairs are NOT stored here: each batch request's custom_id
-- encodes "<user_id>__<YYYY-MM-DD>" (the user's most-recent local summary date,
-- frozen at submit), so collect re-derives both from the batch results — no
-- roster column can drift from what was actually submitted.
--
-- status lifecycle:
--   submitted  -> collected   (results fetched, parsed, insights stored)
--   submitted  -> expired     (terminal: batch errored/expired, or never ended
--                              within the 24h batch window — collect stops
--                              scanning it; those users fall through to computed
--                              tips at read). An infra failure must never look
--                              like "still processing" forever.
--
-- Service-role only: the crons use the service-role client (bypasses RLS).
-- RLS is enabled with NO policies so the anon/authenticated roles can't read it.

create table if not exists insight_batches (
  id            uuid primary key default gen_random_uuid(),
  batch_id      text not null unique,          -- Anthropic's batch id (msgbatch_...)
  model         text not null,                 -- e.g. claude-haiku-4-5-20251001
  status        text not null default 'submitted'
    check (status in ('submitted', 'collected', 'expired')),
  request_count int  not null,                 -- how many users were in the batch
  submitted_at  timestamptz not null default now(),
  collected_at  timestamptz                    -- set when status leaves 'submitted'
);

-- Collect scans outstanding batches by status; index it.
create index if not exists insight_batches_status_idx on insight_batches (status);

alter table insight_batches enable row level security;
-- No policies on purpose: only the service-role client (which bypasses RLS)
-- touches this table. The anon/authenticated API can neither read nor write it.
