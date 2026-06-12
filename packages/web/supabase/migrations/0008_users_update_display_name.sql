-- Pulse — Phase 4g, migration 0008: let a user edit their own display_name.
-- Apply in the Supabase SQL editor AFTER 0007_work_schedules.sql.
--
-- Mirrors 0003's revoked_at pattern exactly: an UPDATE-own policy plus a
-- column-level grant restricted to ONE column. The authenticated role can set
-- display_name on its own row and nothing else — email and role stay writable
-- only by the service-role provisioning in /auth/callback. Worst case if a user
-- abuses this directly via the anon API: they rename themselves. No escalation.
--
-- Additive only: no existing policy or grant is altered.

create policy "Users update own profile"
  on users for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

revoke update on users from authenticated;
grant update (display_name) on users to authenticated;
