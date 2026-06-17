-- Pulse — Phase 4a, migration 0002: Row Level Security on daily_summaries.
-- Apply in the Supabase SQL editor AFTER 0001_auth_users.sql.
--
-- From now on, a signed-in user reading daily_summaries through the anon key sees
-- ONLY their own rows. The /api/ingest route writes via the service-role client,
-- which bypasses RLS — that's intentional and temporary (4b adds per-device token
-- auth). There is no INSERT/UPDATE policy, so the authenticated role cannot write.
--
-- Note the ::text cast: daily_summaries.user_id is a text column (the Phase 2
-- device-UUID), while auth.uid() returns uuid. Today a user's auth id won't match
-- any device-keyed rows, so this correctly returns zero rows for them until 4b
-- rebinds the agent to the authenticated account.
--
-- (No `scores` table exists yet — Phase 3 scoring is computed on the fly by pure
-- functions, not stored — so there is nothing to secure there.)

alter table daily_summaries enable row level security;

create policy "Users read own summaries"
  on daily_summaries for select
  to authenticated
  using (user_id = auth.uid()::text);
