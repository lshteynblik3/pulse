-- Pulse — Phase 4c, migration 0007: the `work_schedules` table.
-- Apply in the Supabase SQL editor AFTER 0006_indexes.sql.
--
-- One row per user, created on first save from /settings/work-schedule. NO row
-- is required to exist: "no row" means "use DEFAULT_SCHEDULE from
-- packages/shared/src/scoring.ts" — the GET route and the scoring loader share
-- that one constant, so an unconfigured user can never see different defaults
-- in different places. The agent never reads or writes this table; WorkSchedule
-- is not part of the agent↔server contract.

create table if not exists work_schedules (
  -- PK = FK: one row per user, and the primary key doubles as the upsert
  -- conflict target for PUT /api/work-schedule.
  user_id        uuid primary key references auth.users (id) on delete cascade,
  working_days   smallint[] not null,           -- 0 = Sunday … 6 = Saturday, matching scoring's dayOfWeek()
  daily_hours    numeric not null,              -- expected hours per working day
  vacation_dates date[] not null default '{}',  -- local civil days ("YYYY-MM-DD")
  breaks         jsonb not null default '[]',   -- Array<{label?, start: "HH:MM", end: "HH:MM"}>, local time
  updated_at     timestamptz not null default now(),

  -- zod in the API is the real validator; these are the backstop for anything
  -- that ever writes outside it.
  constraint work_schedules_daily_hours_range
    check (daily_hours > 0 and daily_hours <= 24),
  constraint work_schedules_working_days_nonempty
    check (array_length(working_days, 1) >= 1),
  constraint work_schedules_working_days_range
    check (working_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[])
);

alter table work_schedules enable row level security;

-- Defense in depth (the 4b pattern): the API routes check the session user AND
-- these policies scope every statement to the row owner. All schedule access
-- runs on the user's session client — no service-role use for schedules, so the
-- documented service-role count stays at two.
create policy "Users read own schedule"
  on work_schedules for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users insert own schedule"
  on work_schedules for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users update own schedule"
  on work_schedules for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No delete policy on purpose: nothing deletes a schedule — "back to defaults"
-- is just saving the default values. Account deletion still removes the row via
-- the auth.users cascade, which doesn't go through RLS.
