# CLAUDE.md
CURRENT PHASE: Phase 4b (this branch) — agent pairing + scoped ingest.
Built on main; phase-4a's auth plumbing is lifted byte-identically (see
the lift commit), NOT merged. 4c (WorkSchedule settings), 4d (dashboard
data API), 4e (dashboard UI) follow.

Context for working on **Pulse**. Read this at the start of every session.
Full detail lives in `SPEC.md` — read it before any architectural work.

## What this is

A privacy-first productivity coaching tool ("Whoop for work"). A desktop agent measures
focus patterns on each employee's machine; a web app shows employees a personal coach and
managers team-level trends. The product only works if it feels supportive, not like
surveillance — that shapes the architecture.

## Hard rules — never violate

1. **Never capture** keystrokes, screenshots/screen contents, window titles, URLs/browsing
   history, message or document contents, mouse movement, webcam/mic. Only app name +
   category, active/idle time, focus-block timing, calendar meeting minutes, task counts.
2. **The agent aggregates locally.** Raw `ActivityEvent`s never leave the machine. The only
   payload sent to the server is a `DailySummary`.
3. **Managers see team aggregates by default.** Viewing an individual's detail must write an
   `access_logs` row and notify that user.
4. **Don't change the data contract casually.** `ActivityEvent` and `DailySummary` in
   `shared` are the spine of the system. Propose changes explicitly before making them.

## Stack

- pnpm monorepo: `agent` (Electron + active-win), `web` (Next.js App Router, = dashboard
  + API), `shared` (TypeScript types — the contract)
- Supabase (Postgres + Auth) · Vercel (hosting + Cron) · Anthropic Claude API (insights)
  · Stripe (per-seat billing)
- TypeScript everywhere. Plain Postgres for now (no Timescale until needed).

## Repo structure

```
/agent    Electron desktop tracker
/web      Next.js — /app (dashboard pages) + /app/api (ingest, summary, etc.)
/shared   shared types: ActivityEvent, DailySummary, Category, scoring types
```

`shared` is imported by both `agent` and `web` — keep these in sync, never duplicate the types.

## The contract (see SPEC.md for full fields)

- `ActivityEvent` — agent-internal only.
- `DailySummary` — the one thing sent to the server; unique per (user_id, date).

## Conventions

- Pure, testable functions for scoring (`web/lib/scoring`). Unit tests alongside.
- Validate every API input with zod before touching the database.
- Secrets in env vars, never committed. Encrypt integration tokens at rest.
- Small commits, one phase per branch. Explain non-obvious tradeoffs in the PR description.
- This user is solo and semi-technical: prefer clear, conventional code over clever
  abstractions. When you make a meaningful choice, say why in one sentence.

### Pairing (Phase 4b)

- Agent identity comes from the bearer token's `device_tokens` row, never from the
  request body. `/api/ingest` must overwrite `summary.userId` with the authenticated
  user_id before upsert.
- `/api/ingest` accepts any `date` the agent claims — no "is it today" check, ever.
  The recovery-flush path legitimately sends prior-day summaries.
- The plaintext device token exists in exactly three places: the one-time
  pair/consume response, the agent's process memory, and the agent's
  safeStorage-encrypted `device-token.bin`. Never in a DB row, log line, or any
  other response. Pairing-code values are never logged either, even on failures.
- Service-role Supabase usage is limited to two documented sites: the pair/consume
  claim+insert, and the ingest token lookup. Everything else runs on the user's
  session client under RLS.
- Known issue (accepted, not solved in 4b): if a user pairs two devices, the
  daily_summaries upsert is last-write-wins per (user_id, date) — one machine's
  day overwrites the other's. Multi-device merging is a later phase.

## Current phase

Phase 1 — DONE. Thin vertical slice works end to end: Electron agent → `/api/ingest` →
Supabase `raw_events` → `/dashboard`, on real data. Next up: Phase 2 (real agent —
categorization, idle detection, focus blocks, local aggregation; stop sending raw events
and send only `DailySummary`). Don't build features ahead of the current phase.

## Commands

(fill in as the project takes shape)
```
pnpm dev:web     # run the Next.js app
pnpm dev:agent   # run the Electron agent
pnpm test        # run tests
```
