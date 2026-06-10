-- Pulse — Phase 4a, migration 0001: the `users` table.
-- Apply in the Supabase SQL editor AFTER the Phase 2 baseline (supabase/schema.sql),
-- and BEFORE 0002_rls_daily_summaries.sql.
--
-- This is the app's profile row for each authenticated account. Its id IS the
-- Supabase Auth user id (auth.users.id), so app data keys off auth.uid().
-- org_id / team_id are intentionally nullable — orgs and teams arrive in Phase 6.

create table if not exists users (
  id           uuid primary key references auth.users (id) on delete cascade,
  org_id       uuid,                       -- nullable until Phase 6 (orgs)
  team_id      uuid,                       -- nullable until Phase 6 (teams)
  email        text not null,
  display_name text,                       -- defaults to the email local-part on first sign-in
  role         text not null default 'member'
    check (role in ('member', 'manager', 'admin')),
  created_at   timestamptz not null default now()
);

-- Each user can read only their own profile row. The app provisions/updates rows
-- via the service-role client (which bypasses RLS), so no insert/update policy is
-- needed here. Without RLS, the auto-generated API would let any authenticated
-- user read everyone's email — this closes that.
alter table users enable row level security;

create policy "Users read own profile"
  on users for select
  to authenticated
  using (id = auth.uid());
