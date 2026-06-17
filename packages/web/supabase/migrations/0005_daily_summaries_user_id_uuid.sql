-- Pulse — Phase 4b, migration 0005: daily_summaries.user_id text -> uuid.
-- Apply in the Supabase SQL editor AFTER 0004_pairing_codes.sql and BEFORE
-- 0006_indexes.sql.
--
-- Through Phase 3 the agent was anonymous and keyed rows by a device UUID stored
-- as text. From 4b on, /api/ingest derives user_id from the bearer token's
-- device_tokens row, so the column becomes a real foreign key to auth.users.
--
-- SAFETY: this migration only runs against an EMPTY table. Pre-auth device-keyed
-- rows cannot be mapped to an auth user automatically; if any exist, we RAISE
-- and stop before touching anything — the operator decides whether to delete
-- them or hand-map them to a real auth.users id first. Never truncate silently.

do $$
begin
  if exists (select 1 from daily_summaries limit 1) then
    raise exception
      'daily_summaries is not empty: pre-auth rows must be deleted or manually remapped before 0005 can run.';
  end if;
end $$;

-- user_id is half of the composite primary key, so the PK goes first, then the
-- 4a SELECT policy that references the column, then the column itself.
drop policy "Users read own summaries" on daily_summaries;
alter table daily_summaries drop constraint daily_summaries_pkey;
alter table daily_summaries drop column user_id;

alter table daily_summaries
  add column user_id uuid not null references auth.users (id) on delete cascade;

alter table daily_summaries add primary key (user_id, date);

-- Same policy as 0002, minus the ::text cast that bridged the old text column.
create policy "Users read own summaries"
  on daily_summaries for select
  to authenticated
  using (user_id = auth.uid());
