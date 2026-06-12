# CLAUDE.md
CURRENT PHASE: 4g (settings consolidation) on branch
phase-4g-settings, stacked on phase-4f-identity. 4f is fully built
and user-verified. 4g (one /settings page with account + devices +
work-schedule sections, /api/account name editing, dashboard
last-activity line, devices list filtered to active) is built and
awaits the user's verification — including manual apply of
migration 0008. phase-4g-settings tip is now the full picture.
Nothing merged to main yet — held until Phase 4 fully closes: user
verifies, then phase close + merge to main. Don't start Phase 5
(and the email+password/OAuth auth rework is its own later phase —
signup-time name capture belongs there, NOT here).

BRANCH-TOPOLOGY CORRECTION (2026-06-11): this file used to claim
the Phase-4 branches were stacked 4a → fix-categorization → 4b → …
That was never true in git. phase-4b was built directly on Phase 3;
4a's auth was lifted in VERBATIM as commit a373106 (not a merge),
and fix-categorization was never merged into the 4b→4c→4d→4e
lineage at all — its agent work lived only on its own branch and
the archive/integration-check tag until Phase 4f Stage 1 ported it
(from that tag's settled resolutions) in commit 05c4959.

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
- Service-role Supabase usage is limited to: the pair/consume claim+insert, the
  shared device-token auth helper (`web/src/lib/devices/auth.ts`) + its
  enumerated callers — /api/ingest (summary upsert) and /api/me (whoami: that
  token's own user's email/display name, no parameters, no list) — and the
  first-sign-in users-row provisioning upsert in /auth/callback (which predates
  this list and went unlisted until 4g; it's ignoreDuplicates, so it can never
  overwrite an edited profile). Everything else runs on the user's session
  client under RLS.
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

### Identity & lineage (Phase 4f)

- The `entertainment` Category member (a known, deliberately non-productive
  bucket, distinct from `other`) now lives on this lineage — it came across in
  the Stage 1 port with the rest of fix-categorization (three-layer classifier,
  rolling-day persistence via day-store, Transparency-panel restart fix, manual
  flush control). The agent's internal `unknown` state stays agent-only, never
  transmitted.
- GET /api/me is the agent's whoami: device-token auth via the shared helper,
  returns only that token's own user's email/display name. The agent calls it
  at `deviceAuth.metadata.serverUrl` on startup and after pairing; the email is
  MEMORY-ONLY in the agent (PII — never written to disk; device.json stays
  non-secret metadata). Tray + Transparency panel show "Paired as <email>";
  the dashboard top bar shows the signed-in session's email. This exists
  because an agent once posted to one account while the browser viewed
  another, and neither UI could show it.
- A whoami 401 only DISPLAYS "pairing invalid" — the ingest 401 path remains
  the sole owner of wiping a dead credential.

### Settings (Phase 4g)

- ONE /settings page (account, devices, work schedule as anchored sections);
  /settings/devices and /settings/work-schedule are redirects to its anchors.
  The page uses settings.module.css in the 4e visual language — the sanctioned
  migration off inline styles, not a new pattern.
- /api/account (GET/PUT, session client): email read-only (the auth identity),
  display_name editable. Defense-in-depth like work-schedule: zod .strict()
  (a crafted email field is rejected, not ignored) at the app layer, and
  migration 0008's UPDATE-own policy + display_name-ONLY column grant at the
  DB layer (mirrors 0003's revoked_at pattern). The agent tray prefers
  displayName over email once set. The future auth phase pre-fills this
  section; it does not rework it.
- Data-retention convention: revoked device_tokens rows are KEPT forever as an
  audit trail (0003's design — created_at/last_used_at/revoked_at per
  credential); /api/devices lists ACTIVE rows only. pairing_codes rows are
  likewise lazy-expired by predicate, never swept.
- "Last activity" = max(device_tokens.last_used_at) across the user's devices
  (revoked included — past posts are real activity), supplied to
  DashboardPayload.agent.lastActivityAt by the /api/dashboard route, shown as
  a quiet relative-time line under the dashboard date heading and per-device
  in settings. No agent involvement; ingest already bumps last_used_at.

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
