-- Pulse — Phase 6 (recognition), migration 0013: the notifications table.
-- Apply in the Supabase SQL editor BY HAND, AFTER 0012_orgs_teams.sql. NEVER auto-run.
-- Idempotent throughout (if-not-exists / guarded policy) so a re-paste is a no-op.
--
-- The employee-facing "you've been told" inbox. Designed for BOTH notification
-- types from the start, though only one is written this commit:
--   • 'recognition' — positive, named, manager-triggered (this commit's POST /ack).
--   • 'access'      — neutral accountability for the drill-in / individual-detail
--                     view (a LATER commit; the enum value is reserved now so the
--                     type is stable, but nothing writes it yet).
--
-- IDEMPOTENCY: the unique (recipient_id, event_key) constraint is the guarantee
-- that one notable event yields exactly ONE notification, no matter how many times
-- the manager's client POSTs /ack. The writer uses INSERT ... ON CONFLICT DO
-- NOTHING against this constraint.

create table if not exists notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references users (id) on delete cascade, -- the employee told
  actor_id     uuid references users (id),                            -- the manager who triggered it; nullable for future system notes
  type         text not null check (type in ('recognition', 'access')),
  event_key    text not null,                                         -- dedup identity, e.g. 'recognition:streak:5:2026-06-18'
  title        text not null,
  body         text not null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz,                                           -- nullable; mark-as-read is deferred (needs its own update-own policy + column grant)
  unique (recipient_id, event_key)
);

-- The inbox read: a recipient's notifications, newest first.
create index if not exists notifications_recipient_created_idx
  on notifications (recipient_id, created_at desc);

-- RLS — the insights / daily_summaries discipline, NOT the users column-grant case.
-- A recipient reads their OWN notifications under the session client. There is NO
-- insert/update/delete policy, so with RLS enabled the authenticated role cannot
-- write AT ALL (RLS denies any command without a matching policy, regardless of
-- table grants) — only the service-role writer (POST /ack) can insert. This is why
-- no column grant is needed here: unlike `users` (which HAS an update-own policy and
-- therefore needs column grants to gate WHICH columns), notifications has no write
-- policy whatsoever, so the row-level deny is the whole gate.
--
-- WARNING: do NOT add an insert/update/delete policy later without re-deriving this.
-- The moment a write policy exists, members can write per that policy — at which
-- point you'd need the column-grant allowlist discipline (see migration 0009) to
-- keep type/actor_id/recipient_id unforgeable.
alter table notifications enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notifications' and policyname = 'Recipients read own notifications'
  ) then
    create policy "Recipients read own notifications"
      on notifications for select
      to authenticated
      using (recipient_id = auth.uid());
  end if;
end $$;
-- No insert/update/delete policy: only the service-role POST /ack writes here.
