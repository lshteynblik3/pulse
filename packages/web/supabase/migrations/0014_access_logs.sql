-- Pulse — Phase 6 (manager drill-in), migration 0014: the access_logs table.
-- Apply in the Supabase SQL editor BY HAND, AFTER 0013_notifications.sql. NEVER auto-run.
-- Idempotent throughout (if-not-exists / guarded policy) so a re-paste is a no-op.
--
-- The accountability record for the ONLY path that exposes an individual member's
-- real metrics to a manager (POST /api/members/[memberId]/view). Per SPEC: id,
-- manager_id, viewed_user_id, viewed_at.
--
-- ONE ROW PER VIEW — deliberately NO event_key and NO unique constraint. Five opens
-- = five rows: this is the full audit trail of every deliberate view. (The calm
-- human signal is the SEPARATE access notification, which IS coalesced to one per
-- manager/member/day in the notifications table — different cardinality on purpose.)

create table if not exists access_logs (
  id             uuid primary key default gen_random_uuid(),
  manager_id     uuid not null references users (id) on delete cascade, -- who looked
  viewed_user_id uuid not null references users (id) on delete cascade, -- who was looked at
  viewed_at      timestamptz not null default now()
);

-- The "who viewed me" read (by the viewed user); and a manager's own audit (future).
create index if not exists access_logs_viewed_user_idx on access_logs (viewed_user_id, viewed_at desc);
create index if not exists access_logs_manager_idx     on access_logs (manager_id, viewed_at desc);

-- RLS — the insights / notifications discipline (RLS-enabled + no write policy ⇒ the
-- authenticated role cannot write at all, regardless of grants; only the service-role
-- drill-in route inserts here).
--
-- READ = the VIEWED user reads their OWN rows. access_logs is the employee's
-- accountability record ABOUT THEM: the notification is the push signal, this log is
-- the durable pull history of every time a manager opened their detail — the
-- transparency half of accountability-both-ways. No manager-read policy and no viewer
-- UI this commit; the policy is ready for a later "who viewed me" surface.
--
-- WARNING: do NOT add an insert/update/delete policy later without re-deriving this —
-- a write policy would let members write per that policy (see 0009's column-grant
-- discipline if that ever becomes necessary).
alter table access_logs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'access_logs' and policyname = 'Viewed user reads own access logs'
  ) then
    create policy "Viewed user reads own access logs"
      on access_logs for select
      to authenticated
      using (viewed_user_id = auth.uid());
  end if;
end $$;
-- No insert/update/delete policy: only the service-role drill-in route writes here.
