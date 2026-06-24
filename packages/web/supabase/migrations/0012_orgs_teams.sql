-- Pulse — Phase 6 (manager / team view), migration 0012: orgs + teams.
-- Apply in the Supabase SQL editor BY HAND, AFTER 0011_insights.sql. NEVER auto-run.
-- Idempotent throughout (if-not-exists / guarded policies) so a re-paste is a no-op.
--
-- This is the team layer's SCHEMA + RLS POSTURE only. The aggregate endpoint, the
-- drill-in / access_logs / notify flow, and team insights are LATER commits — this
-- migration creates no access_logs or notifications table.
--
-- users.org_id / users.team_id / users.role ALREADY EXIST (0001 planted them
-- nullable "for Phase 6"). This migration does NOT re-add them — it only creates the
-- tables they point at and adds the foreign keys.

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists teams (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs (id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

-- ── Foreign keys on the existing users columns ──────────────────────────────
-- Both columns stay NULLABLE: a nullable FK skips its check when the value is null,
-- so existing rows (org_id / team_id still null) validate clean with no backfill.
-- A null team_id / org_id is a real state — "unassigned": the manages helper treats
-- such a user as managing nobody and managed by nobody.
--
-- ADD CONSTRAINT has no IF NOT EXISTS, so each is guarded to keep the migration
-- re-pastable.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_org_id_fkey'
  ) then
    alter table users
      add constraint users_org_id_fkey foreign key (org_id) references orgs (id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'users_team_id_fkey'
  ) then
    alter table users
      add constraint users_team_id_fkey foreign key (team_id) references teams (id);
  end if;
end $$;

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Team / org roster reads (later Phase-6 endpoints) filter on these.
create index if not exists users_team_id_idx on users (team_id);
create index if not exists users_org_id_idx  on users (org_id);
create index if not exists teams_org_id_idx   on teams (org_id);

-- ── RLS posture ─────────────────────────────────────────────────────────────
-- READ-OWN ONLY. An authenticated user may read the single org row and single team
-- row that match their OWN users.org_id / users.team_id — nothing else. This lets
-- the UI show "Team Foo" / "Org Bar" without a service-role call, but a manager
-- CANNOT enumerate sibling teams or other orgs (no blanket listing). There is no
-- INSERT / UPDATE / DELETE policy: orgs and teams are written by service-role /
-- manual seeding only, mirroring how users rows are provisioned in /auth/callback.
alter table orgs  enable row level security;
alter table teams enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'orgs' and policyname = 'Users read own org'
  ) then
    create policy "Users read own org"
      on orgs for select
      to authenticated
      using (id = (select org_id from users where id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'teams' and policyname = 'Users read own team'
  ) then
    create policy "Users read own team"
      on teams for select
      to authenticated
      using (id = (select team_id from users where id = auth.uid()));
  end if;
end $$;

-- ── GRANTS on users: add NONE. ──────────────────────────────────────────────
-- This is the authorization spine and it is enforced at the GRANT layer, not in
-- app code. The standing state (set in 0008) is:
--     revoke update on users from authenticated;
--     grant  update (display_name) on users to authenticated;
-- Column grants on `users` are an ALLOWLIST. `authenticated` holds UPDATE on
-- display_name ONLY; role / team_id / org_id (and is_paid) were NEVER granted, so a
-- member cannot write their own role or team — a member promoting themselves to
-- manager is rejected by the database before any app code runs. A column added by
-- ALTER TABLE is auto-granted to no one, which is exactly why this works.
--
-- No GRANT is added here, and no redundant REVOKE is needed: these columns are
-- already ungranted, and a privilege never granted cannot be exercised. The one
-- thing that would break this is a blanket `grant update on users to authenticated`
-- — it would silently re-expose role / team_id / org_id / is_paid and turn
-- authorization into a self-serve form. NEVER issue that. Keep users grants
-- explicit and per-column, forever.

-- ── SEEDING TEMPLATE — example only; edit ids and run MANUALLY. NOT schema. ──
-- There is no onboarding flow yet (Phase 8). Seed orgs / teams / roles by hand in
-- the SQL editor. role / org_id / team_id are service-role-only columns, so this
-- manual SQL (run as the SQL-editor superuser) is the intended and only way to
-- assign them. Fill in real ids before running; the block below is commented out.
--
-- SEEDING INVARIANT: a user's org_id MUST equal their team's org_id whenever both
-- are set. The manages helper's ADMIN branch trusts users.org_id directly, so a
-- mis-seeded org_id that disagrees with the team's org would mis-scope an admin
-- ACROSS TENANTS. We do NOT add a constraint this commit, but a future migration
-- should consider enforcing it, e.g. a trigger (a plain CHECK can't reference
-- another table) asserting
--     (select org_id from teams t where t.id = NEW.team_id) = NEW.org_id
-- whenever NEW.team_id is not null. Until then it is a manual-seeding discipline.
--
-- insert into orgs (name) values ('Acme Inc')
--   returning id;  -- note the org id, call it <ORG_ID>
--
-- insert into teams (org_id, name) values ('<ORG_ID>', 'Platform')
--   returning id;  -- note the team id, call it <TEAM_ID>
--
-- -- Promote the manager (org_id MUST match the team's org_id — see the invariant):
-- update users set role = 'manager', org_id = '<ORG_ID>', team_id = '<TEAM_ID>'
--   where email = 'manager@acme.example';
--
-- -- Assign members to the same org + team:
-- update users set role = 'member', org_id = '<ORG_ID>', team_id = '<TEAM_ID>'
--   where email in ('alice@acme.example', 'bob@acme.example');
