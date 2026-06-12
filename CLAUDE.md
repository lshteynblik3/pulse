# CLAUDE.md
CURRENT PHASE: ALL of Phase 4 is built — 4a, fix-categorization,
4b, 4c, 4d (dashboard data API), and 4e (employee dashboard UI),
each on its own branch, stacked in that order (phase-4e tip is the
full picture). The old integration-check branch is deleted; its
settled merge resolutions live on as tag archive/integration-check.
Nothing merged to main yet — held until Phase 4 fully closes.
Next: the user verifies /dashboard against their own real day,
then phase close + merge to main. Don't start Phase 5.

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
- **`shared` uses `moduleResolution: node16`** — relative imports there need explicit
  `.js` extensions — **and Next needs `resolve.extensionAlias` in `next.config.mjs`
  for any VALUE import of shared** (type-only imports are erased and never hit
  webpack). The alias landed in 4c and got its first live exercise in 4d, when
  /api/dashboard made `web/lib/scoring`'s `DEFAULT_SCHEDULE` value imports reachable —
  `pnpm build:web` green confirmed it. Verified working; keep the alias.
- `WorkSchedule` gained an optional `breaks` field in Phase 4c (a scoring type in
  `shared`, NOT the DailySummary spine; the agent never sends it). Scoring does not
  consume `breaks` yet — 4c persists them for a later phase. No `work_schedules` row
  means "use `DEFAULT_SCHEDULE`"; UI and scoring share that one constant via
  `getWorkSchedule`.
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

### Dashboard (Phases 4d–4e)

- One consolidated `GET /api/dashboard?date=YYYY-MM-DD`, compute-on-read (no scores
  table yet — persistence is a later phase with the cron). `date` is the CLIENT's
  local day, computed in the browser from local Date components — the server never
  derives "today" from its own clock, and nothing ever calls `toISOString()` for a
  civil date. The payload type `DashboardPayload` lives in
  `web/src/lib/dashboard/compute.ts` (web-internal), NOT in `shared`.
- Windowing invariant (documented in compute.ts): fetch 122 days, score the most
  recent 92, so every scored day gets a FULL trailing-30-day median, exclusive of
  the day itself. Don't shrink the fetch window without re-deriving this.
- Absence ≠ failure, end to end: zero rows → 200 with a clean empty payload → calm
  "no data yet" UI. A DB/loader error → 500 → retryable error card. Never render
  fake zeros, never let an error masquerade as an empty day.
- Rounding/formatting is the UI's job only (`web/src/lib/dashboard/format.ts`); the
  API passes scoring's raw values through (the integer `score` aside).
- Coach tone is a product rule, not styling: no red anywhere on the dashboard, and
  low scores read as supportive copy. Score-band copy and colors are unit-tested.
- `/api/summary/today` was DELETED in 4d (it was unauthenticated, service-role, and
  cross-user). The two-documented-sites service-role rule above still holds.
- Styling: the dashboard's CSS module + next/font (Fraunces display face) is the
  pattern the settings pages migrate TOWARD later — not an exception to undo.
  Charts are hand-rolled SVG; reach for recharts only if date navigation or richer
  charts arrive.

## Known issues / debt

- Phase 4b Tests 8 and 9 were verified by code inspection
  rather than end-to-end testing. Test 8 (consume race
  condition): the consume endpoint uses a single
  UPDATE … WHERE consumed_at IS NULL AND expires_at > now()
  RETURNING statement, which is race-safe by Postgres row
  locking on a single statement — only one of two concurrent
  consumes can match. Test 9 (cross-user authorization): API
  routes enforce user_id = auth.uid() in both application
  logic (requireUser + WHERE user_id = $authed_user) and in
  RLS policies. End-to-end verification of test 9 was blocked
  by Supabase free-tier email rate limits during testing
  (3/hour magic links per email, hit during second-user
  signup attempts); re-verify with a fresh email allowance
  when convenient.

## Current phase

See the CURRENT PHASE block at the top — that's the live one. Phases 1–3 are done
and merged; all of Phase 4 is built on the stacked side branches awaiting the
user's real-data check and merge. Don't build features ahead of the current phase
(Phase 5 / AI insights has only a placeholder card in the dashboard).

## Commands

(fill in as the project takes shape)
```
pnpm dev:web     # run the Next.js app
pnpm dev:agent   # run the Electron agent
pnpm test        # run tests
```
