-- Pulse — Phase 1 schema (thin vertical slice).
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- This is the ONLY table for Phase 1. It stores raw activity events purely to
-- prove the pipeline end-to-end. Per the privacy architecture, raw events are
-- TEMPORARY: Phase 2 stops sending them and the server will only ever hold a
-- DailySummary. Do not build on this table long-term.

create table if not exists raw_events (
  id          uuid primary key default gen_random_uuid(),
  app_name    text        not null,
  started_at  timestamptz not null,
  ended_at    timestamptz not null
);

-- Speeds up the "today" summary query, which filters by started_at.
create index if not exists raw_events_started_at_idx on raw_events (started_at);
