-- Pulse — Phase 4b, migration 0003: the `device_tokens` table.
-- Apply in the Supabase SQL editor AFTER 0002_rls_daily_summaries.sql and
-- BEFORE 0004_pairing_codes.sql.
--
-- One row per paired agent install. The agent authenticates /api/ingest with a
-- bearer token; the server stores ONLY the sha256 hex hash of that token. The
-- plaintext token exists in exactly three places, none of them here: the one-time
-- pair/consume response, the agent's process memory, and the agent's
-- safeStorage-encrypted blob on disk.

create table if not exists device_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  token_hash   text not null unique,      -- sha256 hex of the token; never the token
  device_label text,                      -- user-friendly name ("Work laptop")
  last_used_at timestamptz,               -- bumped on each successful ingest auth
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz                -- null = active; set once, never cleared
);

alter table device_tokens enable row level security;

-- A signed-in user can list their own devices (powers /settings/devices and
-- GET /api/devices). The unique constraint on token_hash already provides the
-- index ingest's lookup needs.
create policy "Users read own devices"
  on device_tokens for select
  to authenticated
  using (user_id = auth.uid());

-- Revocation: a user may UPDATE their own rows, but column-level grants limit
-- what they can touch to revoked_at alone. This keeps service-role usage down to
-- its two documented sites (pair/consume INSERT, ingest token lookup) — the
-- DELETE /api/devices/:id handler revokes through the user's own session client.
-- Worst case if a user abuses this directly via the anon API: they revoke their
-- own device. No escalation path.
create policy "Users revoke own devices"
  on device_tokens for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke update on device_tokens from authenticated;
grant update (revoked_at) on device_tokens to authenticated;

-- INSERTs happen only via the service-role client in /api/devices/pair/consume
-- (the agent has no session at pairing time). No insert/delete policies on
-- purpose: the authenticated role cannot mint or remove tokens.
