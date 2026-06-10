-- Pulse — Phase 4b, migration 0004: the `pairing_codes` table.
-- Apply in the Supabase SQL editor AFTER 0003_device_tokens.sql and BEFORE
-- 0005_daily_summaries_user_id_uuid.sql.
--
-- A pairing code is a short-lived, single-use bridge between a signed-in web
-- session and an agent that has no credentials yet. Lifecycle (enforced by
-- predicates, not by a sweeper):
--   ACTIVE    consumed_at is null AND expires_at > now()   — consumable
--   CONSUMED  consumed_at is set                           — terminal
--   EXPIRED   consumed_at is null AND expires_at <= now()  — terminal, lazy
-- The consume endpoint claims a code with a single conditional UPDATE, so two
-- racing agents can never both succeed (row-level locking picks one winner).

create table if not exists pairing_codes (
  code         text primary key,           -- 8 chars, A-Z minus O/I/L + 2-9
  user_id      uuid not null references auth.users (id) on delete cascade,
  expires_at   timestamptz not null,       -- now() + 10 minutes at issue time
  consumed_at  timestamptz,                -- set exactly once by pair/consume
  device_label text,                       -- captured from the agent at consume
  created_at   timestamptz not null default now()
);

alter table pairing_codes enable row level security;

-- /api/devices/pair/issue runs with the USER'S session client (anon key +
-- cookies), so these two policies are the whole authorization story for issuing:
-- RLS itself guarantees a user can only mint codes bound to their own user_id.
create policy "Users read own pairing codes"
  on pairing_codes for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users issue own pairing codes"
  on pairing_codes for insert
  to authenticated
  with check (user_id = auth.uid());

-- The consume side (claim + mark consumed) runs via the service-role client in
-- /api/devices/pair/consume — the agent has no session, so that endpoint is
-- public by design and RLS is bypassed for its one UPDATE. No update/delete
-- policies for authenticated: a user cannot un-consume or extend a code.
