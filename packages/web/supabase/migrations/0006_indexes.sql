-- Pulse — Phase 4b, migration 0006: helper indexes.
-- Apply in the Supabase SQL editor AFTER 0005_daily_summaries_user_id_uuid.sql.
-- Last migration of Phase 4b.

-- Supports a future expired-code cleanup sweep (a cron deleting rows where
-- expires_at < now() - some grace). Correctness never depends on that sweep —
-- consume checks expires_at inline — this just keeps it cheap when it arrives.
create index if not exists pairing_codes_expires_at_idx
  on pairing_codes (expires_at);

-- Deliberately skipped:
--   device_tokens (token_hash)      — the UNIQUE constraint in 0003 already
--                                     creates the index ingest's lookup uses.
--   daily_summaries (user_id, date) — recreated as the composite PRIMARY KEY in
--                                     0005, which is an index.
