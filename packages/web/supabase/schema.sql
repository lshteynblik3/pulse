-- Pulse — Phase 2 schema (the privacy spine).
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- Phase 2 makes hard rule #2 real: the server only ever stores a DailySummary.
-- The Phase 1 raw_events table is intentionally REMOVED here — raw activity must
-- never reach the server. This is a deliberate teardown, not a leftover.

-- 1) Tear down the Phase 1 scaffolding.
drop table if exists raw_events;

-- 2) The one table the server keeps: one aggregated DailySummary per user per
--    local day. Columns mirror the DailySummary contract in @pulse/shared.
create table if not exists daily_summaries (
  user_id             text             not null,
  date                date             not null,        -- the user's LOCAL day, computed by the agent
  active_minutes      double precision not null default 0,
  focus_minutes       double precision not null default 0,
  meeting_minutes     double precision not null default 0,
  category_breakdown  jsonb            not null,        -- Record<Category, number>
  focus_block_count   integer          not null default 0,
  focus_block_minutes double precision not null default 0,
  hourly_focus_minutes jsonb           not null,        -- number[24], local hour 0–23
  tasks_completed     integer          not null default 0,
  agent_version       text             not null,
  updated_at          timestamptz      not null default now(),

  -- One row per user per local day. Re-sends (every ~15 min) upsert this row.
  primary key (user_id, date)
);

-- Speeds up "latest summary" reads on the dashboard.
create index if not exists daily_summaries_date_idx on daily_summaries (date desc);
