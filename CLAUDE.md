# CLAUDE.md
CURRENT PHASE: Phase 6 (manager / team view) — manager-facing surface
COMPLETE and merged to main via the --no-ff merge of phase-6-drill-in. The
team aggregate, recognition prompts, and manager drill-in are all on main.
ONE Phase-6 piece remains: team-level AI insights (paid). NOT DEPLOYED —
go-live stays deferred to Phase 8 (same as Phase 5).

PHASE-6 MERGE TOPOLOGY: four commits were built as a LINEAR STACK, each
branched off the previous, and merged to main as ONE --no-ff bubble (the
stack was one coherent phase). In order: phase-6-teams-foundation (bc86eaf,
orgs/teams/manages/RLS) → phase-6-team-aggregate (09e1735, aggregate + k=3
floor) → phase-6-recognition (6a0c478, recognition + notifications 0013 +
the GET-read/POST-ack split) → phase-6-drill-in (1906d4f, drill-in +
access_logs 0014). Merge commit 9b1f6ee. All four branches kept, none
deleted. The four commit hashes are reachable under the single merge commit.

PHASE-6 AUTHORIZATION MODEL (the spine — read before any team-data work):
Managers have NO blanket RLS read on member rows. Every manager read goes
through a narrow service-role endpoint, session-authed, gated by the
`manages` TypeScript helpers (canManageUser / canManageTeam, commit 1) which
run BEFORE any member read. The manages relationship is the single
authorization source of truth. Role/team_id/org_id on users are
service-role-write-only (the is_paid column-grant allowlist discipline) — a
member cannot self-promote. Three privacy invariants are STRUCTURAL, not
conventional: (1) team aggregates suppressed below k=3 REPORTING members
(fixed system constant, never a setting — the manager the floor protects
against must not control it); (2) recognition is positive-only, sparse, and
manager-saw ⟺ employee-told (a card shows only via a render-time POST that
writes the notify; no prefetchable GET writes); (3) drill-in is the ONLY
path to an individual's real metrics — POST-only (no prefetchable GET),
canManageUser-gated, read→log→notify→serve so detail never crosses the wire
without a durable access_logs row + access notification, and the private
coaching insights are NEVER in the manager payload (strengths only).

PHASE-5 MERGE TOPOLOGY: built on phase-5-insights-worker (off main);
the temporal-language fix stacked on phase-5-insights-temporal; the
throwaway model bench on phase-5-insights-bench. It landed as
temporal → worker (--no-ff 26c0bcb) → main (--no-ff 0765749). The
paid-flag stub (migration 0009) had merged to main earlier (--no-ff
c6fd335). The bench branch is throwaway and was NOT merged; all
Phase-5 branches are kept (not deleted).

PHASE-4 BRANCH-TOPOLOGY HISTORY (correction logged 2026-06-11; the
stack landed on main via --no-ff merge 9895b4a on 2026-06-16). The
Phase-4 lineage was NEVER the stacked 4a → fix-categorization → 4b
→ … this file once claimed. In git: phase-4b was built directly on
Phase 3; 4a's auth was lifted in VERBATIM as commit a373106 (not a
merge); and fix-categorization was never merged into the
4b→4c→4d→4e lineage at all — its agent work lived only on its own
branch and the archive/integration-check tag (a dead-end) until
Phase 4f Stage 1 ported it (from that tag's settled resolutions) in
commit 05c4959. That spine — continued through 4f–4i and batches
A/C/D on batch-d-score-display — is what merge 9895b4a brought to
main as a unit.

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
/web      Next.js — /app (dashboard pages) + /app/api (ingest, dashboard, agent/today,
          cron/insights/{submit,collect}, etc.)
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
- Insights name days by WEEKDAY NAME, never "today"/"tomorrow"/"yesterday" — a stored
  insight is read a day or more after it's written, so a relative word points at the
  wrong day (the "read-a-day-later" rule). Both the LLM builder and the computed-tips
  fallback label the coached day and the next working day by weekday; helpers
  `nextWorkingDay` / `previousWorkingDay` / `weekdayName` are pure functions in
  `web/lib/scoring/date-utils` (`previousWorkingDay` is built + tested but not yet
  consumed by the builder — reserved). The collect-side relative-word net is the
  backstop (see the Phase 5 section).

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
- Service-role Supabase usage — THE most security-sensitive surface in the
  repo; keep this list exhaustive and auditable. Entries 1–6 are each pinned in
  app code to ONE specific user (the pairing code's, the token's, or the
  session's own) and never take a parameter naming another user. Entries 7–8 are
  the Phase 5 CRON batch jobs — the deliberate exception: no session, operating
  over the paid roster (MANY users), but CRON_SECRET-gated (only Vercel's
  scheduler can invoke them) and every per-user read/write pinned to a legitimate
  target (a paid-roster member, or the user encoded in a batch result's custom_id).
  Entries 9–11 are the Phase 6 team endpoints — session-authed and manages-gated
  (NOT crons): each touches OTHER users but only after a manages check authorizes
  the session manager. #9–10 use canManageTeam: #9 returns team-level aggregates
  only (never an individual row); #10 is the recognition pair — a pure-read GET
  (cards) plus the POST /ack that WRITES another user's notification, pinned to a
  recipient verified on the managed team, only for a re-derived real event. #11 is
  the drill-in — the FIRST consumer of canManageUser (the per-USER check) and the
  ONLY path that exposes an individual member's real metrics to a manager:
    1. /api/devices/pair/consume — pairing-code claim UPDATE + device_tokens
       INSERT (no session exists at pairing time).
    2. The shared device-token auth helper (`web/src/lib/devices/auth.ts`):
       the token-hash lookup, used by every device-authenticated route below.
    3. /api/ingest — daily_summaries upsert for the token's user.
    4. /api/me — users email/display_name read for the token's user.
    5. /api/agent/today (4h) — THREE service-role reads for the
       token's user, feeding the popover's server-computed score:
       daily_summaries (31-day window), work_schedules, and
       device_tokens.last_used_at (the popover's lastActivityAt).
       All three pinned to device.userId. No RLS path exists without
       the deferred embedded-dashboard auth bridge.
       (NOTE: the route docstring + the Batch-D commit message still
       say "2" reads — known doc drift, debt item (d); code is
       correct and pinned.)
    6. /auth/callback — first-sign-in users-row provisioning upsert
       (ignoreDuplicates: can never overwrite an edited profile).
    7. /api/cron/insights/submit (Phase 5) — service-role, CRON_SECRET-gated:
       users.is_paid READ (the paid roster); daily_summaries READS (the roster's
       recent dates, then each rostered user's scoring window); work_schedules via
       getWorkSchedule(admin, userId); insight_batches INSERT (the tracking row).
       No session in a cron; touches many users by design (the roster), each
       downstream call pinned to a roster member's userId.
    8. /api/cron/insights/collect (Phase 5) — service-role, CRON_SECRET-gated:
       insight_batches READ (status='submitted') + UPDATE (status →
       collected/expired); insights DELETE-then-INSERT per (user_id, date), where
       user_id + date are decoded from the batch result's custom_id
       ("<userId>__<date>"). This writes the stored LLM insights. The dashboard
       READS insights under the SESSION client (RLS read-own), NOT here — so a
       user can only ever read their own.
    9. /api/teams/[teamId]/aggregate (Phase 6) — service-role, SESSION-authed +
       manages-gated. The manager's identity comes from auth.getUser() (never the
       body); authorization is canManageTeam(admin, sessionUserId, teamId), which
       403s any team the session user doesn't manage. AUTHORIZATION RUNS FIRST,
       before any team data is read. Service-role reads (managers have no blanket
       RLS read on member rows — that's the design): the team roster (users where
       team_id = teamId) and each rostered member's daily_summaries window +
       work_schedules (via getWorkSchedule(admin, memberId)) — every read pinned to
       a member of a team the session user is VERIFIED to manage, never a team/user
       taken unchecked from the request. Returns team-level aggregates only, gated
       by the k=3 reporting-member floor; NEVER an individual member's row, score,
       or identifier to the client.
    10. /api/teams/[teamId]/recognition (Phase 6) — the recognition pair,
       session-authed + manages-gated (canManageTeam runs FIRST on both verbs).
       GET is a PURE READ (cards), service-role roster/member reads like #9, WRITES
       NOTHING — safe to prefetch. POST /ack is the WRITER: it re-derives the team's
       current events server-side (never trusts the body), then idempotently INSERTs
       (upsert ON CONFLICT (recipient_id, event_key) DO NOTHING) a 'recognition'
       notification for each requested key that matches a REAL current event —
       recipient pinned to a member of the verified-managed team, actor_id = the
       session manager. A fabricated/foreign/stale key writes nothing. This GET/POST
       split makes manager-saw ⟺ employee-told a biconditional (the notify exists
       only because cards rendered, and only via /ack). NO k-anonymity floor on
       recognition (unlike #9's aggregates): it's not silent — it notifies the named
       person — so the notify replaces the floor. The notifications READ
       (GET /api/notifications) is SESSION-client/RLS read-own, NOT here.
    11. POST /api/members/[memberId]/view (Phase 6 drill-in) — service-role,
       session-authed + canManageUser-gated (the per-USER manages check, FIRST
       consumer of it; runs FIRST, before ANY member-data read). The ONLY path that
       exposes an individual member's real metrics to a manager. A DELIBERATE POST
       only — the route exports NO GET, so prefetch/unfurl (GET-only) can never
       trigger a logged view. Strict order: gate → READ+ASSEMBLE in memory → write
       access_logs (ONE row per view) → write the access notification (type='access',
       COALESCED one-per-manager-per-member-per-day via event_key
       access:<managerId>:<targetId>:<date> + ON CONFLICT DO NOTHING) → ONLY THEN
       serve. A write failure ⇒ 500, no detail. Read precedes the writes so a
       member-data read error 500s with NO log/notify (no false "your manager viewed
       you"); the detail still never crosses the wire until both writes are durable.
       NO-DATA still logs+notifies (a deliberate view occurred). Serves score + the
       four breakdown components + focus detail (focus minutes/blocks/hourly) +
       positive strengths — NEVER the coaching insights, NEVER categoryBreakdown
       (payload assembled field-by-field; insights table never queried). The
       access_logs READ is session-client/RLS read-own (viewed_user_id), NOT here.
  Everything else runs on the user's session client under RLS (the dashboard's
  insights read included).
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
  cross-user). The eleven service-role sites enumerated above still hold — entries
  1–6 each pinned to one authenticated identity, 7–8 the Phase-5 CRON_SECRET-gated
  batch jobs, 9–11 the Phase-6 manager-view endpoints (session-authed, manages-gated).
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

### Tray popover (Phase 4h)

- The native tray context menu is GONE; tray click (left or right) toggles a
  frameless, transparent, always-on-top popover (`popover.html`/`popover.js`),
  built on the exact Transparency-panel pattern (same preload, contextBridge,
  handlers-before-windows). Blur and Esc dismiss it; a 300ms reopen guard
  stops the tray-click/blur fight. The Transparency panel stays its own window,
  reachable from the popover's footer link.
- THE SCORE IS SERVER-COMPUTED, full stop. GET /api/agent/today returns
  { date, score|null, message|null, lastActivityAt } — score from scoreDay
  (exported from compute.ts; lookback filtering lives there so no caller can
  get the window wrong) and message from scoreMessage (format.ts): the SAME
  band copy the dashboard renders, one source of truth. The agent passes
  ?date= from its own local day (the agent is the client). score: null means
  "no data that day" → the popover's calm empty state, never a fake zero.
  Single-day scoring fetches 31 days (singleDayWindowStart), not the
  dashboard's 122 — that invariant exists for scoring 92 days.
- score-cache.json (sibling of current-day.json, deliberately NOT a
  PersistedDay field — its validator rejects unknown-typed fields) caches the
  last { score, message, fetchedAt } so the popover opens instantly and
  refreshes behind a visible "updated X ago" hint. Cleared on unpair/401:
  the score belonged to that pairing. Identity (email/name) stays memory-only;
  a score number and a coach sentence are cacheable.
- Renderer duplication boundary: COLORS (band → slate/purple/green) are
  presentational and may be mirrored in popover.js; COPY and SCORES never are.

### Companion widget (Phase 4i)

- The 4h popover is now a PERSISTENT, draggable companion, not a transient
  menu. Only TWO dismiss/restore paths: the × button (hidePopover IPC) and the
  tray toggle. Blur-dismiss AND Esc-dismiss were both deliberately removed — a
  screenshot tool emitted Esc on teardown and hid the widget post-capture; do
  NOT re-add either. The window is demonstrably capturable (no
  setContentProtection anywhere).
- WidgetStateStore (widget-state.ts, mirrors ScoreCache): persists
  {x, y, pinned, compact} in widget-state.json, atomic tmp+rename, validator
  clears corrupt files. `compact` is OPTIONAL/back-compatible — pre-4i files
  without it load as not-compact.
- clampWidgetIntoView runs against the window's LIVE getBounds() at every show
  AND every card↔pill resize — never a constant, because the
  frameless-transparent window reports ~345px not the 340 constant (invisible
  DWM border). All clamp coords are Math.round'd before setBounds (fractional
  pixels render the score blurry).
- Compact mode (card ↔ pill) is PURELY presentational — the tracking path
  (poll → powerMonitor/active-win → sendSummary) reads no window or display
  state, so compact/hidden/full never affects idle/focus detection, the flush
  cycle, or DailySummary. The refresh timer pauses while hidden; tracking does
  not.
- Pill chip: solid slate-900 (~90% opaque), 1px translucent white border, no
  backdrop-filter/text-shadow. Score keeps band colors but the slate band (<40)
  remaps to light slate (#cbd5e1) so a low-score day isn't slate-on-slate.
- Launch shows ONLY the widget. The Transparency panel is lazily created on the
  first show-panel footer click (no startup auto-create), and opening it does
  NOT dismiss the widget.
- Unknown-apps classify nudge: a COUNT ONLY (never app names), from the
  classifier's local unknownQueue (apps past the 10-min unknown threshold),
  broadcast as classify-nudge {count}. Classifying writes via setOverride →
  user-overrides.json (userData, writable in production), applies live on the
  next poll — NO restart. categories.json is the read-only app-bundle seed,
  never a runtime write target. No server call, no new API route, no
  DailySummary change — unclassified app names never leave the machine.
- Service-role surface UNCHANGED this phase: 4i reuses 4h's GET /api/agent/today
  and adds no new server-side surface.

### Batch A — dashboard quick wins

- Logout affordance; a SINGLE Settings nav entry (de-duped); dashboard 5-min
  autorefresh that PAUSES when the tab/window is hidden and keeps the
  currently-viewed date. SHOW_TASKS flag hides the always-zero tasks card — the
  DailySummary `tasksCompleted` field is UNTOUCHED in the contract, reserved for
  Phase 7 integrations (the flag hides UI, it does not change the spine).

### Batch C — date navigation + week summary + non-working-day display

- Date navigation: `?date=` query param, prev/next, a 365-day floor and a
  today-cap (you can't navigate into the future).
- Week summary: rolling-7, averaged over working-days-WITH-data, labelled
  "X of Y tracked," computed via the shared averageScoreOverWorkingDays helper
  so it can't drift from the trend calc.
- Non-working-day daily view: NO score shown, activity still shown if present,
  and "Mark as working day" is a STUB button — a coming-soon placeholder for a
  future per-date schedule-override feature (see backlog (a)).

### Batch D — score /130 display rescale

- displayScore /130: single source in format.ts; the raw score is retained for
  bands/streak/arc; clamped and rounded. Applied ROUTE-SIDE for the agent
  (/api/agent/today) so the agent never multiplies — it just displays what the
  server sends. The popover's non-working-day handling now matches the web view.

### Insights worker (Phase 5)

- TWO crons, not one, to dodge Vercel function timeouts (a batch can take up to
  24h). vercel.json schedules both: SUBMIT at 08:00 UTC, COLLECT at 11:00 UTC.
  Both are service-role and CRON_SECRET-gated (reject any request without
  `Authorization: Bearer <CRON_SECRET>`). All insight code lives in
  `web/src/lib/insights` (pure, unit-tested) with the two routes as thin I/O.
- SUBMIT (`/api/cron/insights/submit`): builds the paid roster — `is_paid = true`
  users with a daily_summary within ROSTER_FRESHNESS_DAYS (2) of the cron's UTC
  reference (selectRoster is the unit-tested gate; the server clock is read ONLY
  for this freshness cutoff, never as a civil "today"). Builds one labelled-lines
  user message per user (compute-on-read context: peak hours, streak, week trend)
  and submits ONE Anthropic Message Batch (Haiku 4.5, claude-haiku-4-5-20251001).
  Stores the batch id in `insight_batches`. No LLM in the free path — only paid
  users ever enter a batch.
- The (user, date) pair rides in each batch request's custom_id ("<userId>__<date>",
  the user's most-recent LOCAL summary date), so COLLECT re-derives both from the
  results — no roster column can drift from what was submitted.
- `insight_batches` (migration 0010) is the SUBMIT→COLLECT bridge. Terminal states:
  submitted → collected (results parsed + stored) or submitted → expired (batch
  errored, or never ended within the 24h window — collect stops scanning it; those
  users fall to computed tips). An infra failure must never look like "still
  processing" forever. COLLECT keys off the PER-REQUEST result status first
  (succeeded vs errored/canceled/expired), with the 24h wall-clock only as the
  batch-level dead-man's switch.
- COLLECT (`/api/cron/insights/collect`): for each ended batch, strip ```fences
  UNCONDITIONALLY → JSON.parse → validate against the frozen insightsSchema. A
  per-user failure (transport / bad custom_id / parse / schema) is skipped + logged
  (custom_id only, never content) and NEVER aborts the batch — that user falls to
  computed tips. Storage is idempotent: delete-then-insert per (user_id, date),
  re-runs change nothing.
- COLLECT-SIDE RELATIVE-WORD NET (belt-and-suspenders): after schema validation,
  any /\b(today|tomorrow|yesterday)\b/i in ANY stored insight's title OR body drops
  that user's ENTIRE set for the date (reason 'relative-word') → computed tips. A
  relative word is schema-VALID, so nothing else catches it; this is the only grep
  on the ACTUAL stored production output (the bench greps the bench; the
  computed-tips unit test greps the fallback). The prompt can't be made perfectly
  reliable — the re-bench measured a 1/30 slip.
- computedTips (`web/src/lib/insights/computed-tips.ts`) is pure, deterministic, and
  NO-LLM. It is BOTH the free-tier path AND the per-user paid fallback (failed/
  missing/relative-word LLM output, or a pre-collect day). Same {type,title,body}
  three-type shape (peak-window | meeting-load | streak) as the LLM, passing the
  same insightsSchema, so the dashboard renders them identically. The dashboard is
  compute-on-read: it shows stored LLM insight rows for the viewed day when present,
  else computedTips — and there is NO LLM call anywhere in the dashboard request
  path (grep-verified; computedTips is sync).
- `insights` table (migration 0011): id, user_id, date, type, title, body,
  created_at; RLS read-own (the dashboard's session-client read), service-role
  write-only (COLLECT). 2–3 rows per (user, date); the schema bounds (title ≤ 60,
  body ≤ 280, 2–3 insights, three types) are a CARD-LAYOUT constraint, not loosened
  — the prompt was tightened for brevity instead after a re-bench length regression.
- COST: the worker gets the Batch API −50% and Haiku 4.5. Prompt caching does NOT
  fire — the ~400-token coach prompt is below Haiku's 4096-token cache minimum, so
  it's batch-discount only. Expected, not a bug; don't add cache_control expecting
  savings at this prompt size.

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

### Backlog / carried-forward debt (post-Phase-4)

- (a) One-off working-day override + target hours — the REAL feature behind
  Batch C's "Mark as working day" stub button. A per-date WorkSchedule-override
  touching isWorkingDay's consumers; deferred to its own phase.
- (b) Scoring display-curve tuning — displayScore is linear ×1.3 for now. If
  "doable" days don't land near 100 once real days accumulate, it's a
  one-function change in format.ts to a data-anchored curve.
- (c) Dashboard perf / scores table — the dashboard is compute-on-read, scoring
  ~92 days/request with no scores table. Fine at low data volume; revisit before
  prod scale or as load grows. This was the dissolved "Batch B" — deliberately
  resolved as a debt note, NEVER a branch, so no batch-b branch exists (its
  absence is correct, not lost work).
- (d) Doc drift — the /api/agent/today route docstring AND the Batch-D commit
  message still undercount its service-role reads as 2 (it's 3 — see entry #5).
  The code is correct and pinned; fix the docs opportunistically.

## Phase 5 gates (CLEARED)

- Anthropic cost control — CLEARED: the worker uses the Batch API (−50%) + Haiku
  4.5. Prompt caching does NOT fire (the ~400-token prompt is under Haiku's
  4096-token cache minimum), so it's batch-discount only — expected, not a bug
  (see the Phase 5 section).
- Paid-gate mechanism: a DELIBERATE MANUAL STUB now exists — `users.is_paid`
  (boolean not null default false), migration 0009. It is a flag the operator
  flips by hand in SQL / service-role to mark a paying account; Phase 5's cron
  gates paid API calls on it so free users never incur Anthropic cost. This is
  NOT billing — Phase 8 replaces it with Stripe subscription state. RLS keeps it
  member-unwritable WITHOUT a new policy: the 0008 update-own policy is
  column-agnostic (gates rows, not columns); the COLUMN GRANT is what gates
  writes, and authenticated is granted UPDATE on `display_name` only — a column
  added by ALTER TABLE is auto-granted to no one. FAILURE MODE TO GUARD: column
  grants on the `users` table are an ALLOWLIST, not a denylist — a later blanket
  `grant update on users to authenticated` would SILENTLY re-expose is_paid (and
  every future column). Keep `users` grants explicit/per-column forever.
- Anthropic API cost-control setup — batch API + prompt caching + Haiku, per the
  playbook's Phase 5 guidance.

## Current phase

See the CURRENT PHASE block at the top — that's the live one. Phases 1–6 are done
and merged to main (Phase 4 via merge 9895b4a, Phase 5 via merge 0765749, Phase 6
via merge 9b1f6ee). Phase 6 added migrations 0012 (orgs/teams), 0013 (notifications),
and 0014 (access_logs), applied by hand to dev. Phases 5 and 6 are COMPLETE but NOT
DEPLOYED — go-live is deferred to Phase 8 (see the top block); do not assume the crons
are running, the team view is live, or those migrations are on prod. The remaining
Phase-6 piece is team-level AI insights (paid); Phase 7 (integrations) follows per the
playbook.

## Commands

(fill in as the project takes shape)
```
pnpm dev:web     # run the Next.js app
pnpm dev:agent   # run the Electron agent
pnpm test        # run tests
```
