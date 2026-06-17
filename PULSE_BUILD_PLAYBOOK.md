# Pulse — Build Playbook

A phase-by-phase guide for building Pulse with Claude Code. Keep this in `/docs`
next to `SPEC.md` and `CLAUDE.md`. Work through it in order, one phase per branch.

This document assumes the two companion files exist:
- **`CLAUDE.md`** (repo root) — auto-loaded context + hard rules.
- **`SPEC.md`** (`/docs`) — full data contract, DB tables, privacy rules, scoring formula.

---

## How to use this document

You are solo and semi-technical. Claude Code will write most of the code, but **you**
are the architect and reviewer. This playbook keeps you driving instead of drifting.

**At the start of every session, paste this first:**

```
Read CLAUDE.md and docs/SPEC.md and docs/PULSE_BUILD_PLAYBOOK.md before doing
anything. We are working on Phase [N]. Do not work ahead of this phase. Tell me
your plan for this phase in plain English before writing any code.
```

Then work through the phase's prompts one at a time — not all at once. After each one:
review the diff, run it, ask Claude Code to explain anything you don't understand, then
commit. Only move on when the phase's "Done when" check passes.

---

## Overall guiding principles

These apply to every phase. They are in `CLAUDE.md` too so Claude Code keeps them in mind.

1. **Contract-first.** The `ActivityEvent` and `DailySummary` types in `shared` are the
   spine of the whole system. Define them before features. Never change them casually —
   make Claude Code justify any change out loud first.
2. **Thin vertical slice before depth.** Get data flowing all the way from agent → backend
   → screen before building any single piece fully. Proving the pipeline is the priority;
   making it pretty comes later.
3. **Privacy is structural, not a feature.** Never capture keystrokes, screenshots, window
   titles, URLs, or message content. The agent aggregates locally; only `DailySummary`
   leaves the machine. Managers see team aggregates; viewing an individual is logged and
   notified. If a generated solution ever violates this, reject it — no exceptions.
4. **The free tier stays deterministic and cheap.** Free users get computed metrics only
   (focus score, peak hours, streaks). **No LLM calls in the free path** — that's what
   would bankrupt you at scale. AI coaching is a paid feature.
5. **Build for one user first, then teams.** Single-player value (your own dashboard)
   before multiplayer (manager view).
6. **Prefer boring, conventional code.** Clarity over cleverness. When Claude Code makes a
   meaningful choice, it should say why in one sentence so you learn the stack.
7. **Ship to milestones, not "finished."** Usable by you after Phase 4. Sellable to a team
   after Phase 6. Everything after is hardening.
8. **Commit working slices.** Small commits. One phase per branch. Never leave the repo
   broken between sessions.
9. **Validate demand early.** Don't sink weeks into integrations and billing before someone
   signals they'd pay. The Phase 6 milestone is your cue to start customer conversations.

---

## Two possible paths — read before Phase 2

The **desktop agent (Phase 2) is the hardest and slowest part** of this whole project:
cross-platform window detection, idle/sleep handling, packaging, code signing, antivirus.
You have two options:

- **Agent-first (this document's default order):** build the tracker early. Richer data,
  but the risky/slow part comes before you've validated demand.
- **Integrations-first (recommended if your bigger risk is "will anyone pay"):** skip
  Phase 2 for now and pull **Phase 7 (integrations)** forward. Build a useful v1 on
  calendar + GitHub/Jira data alone, get companies paying, then add the agent later.

If you take the integrations-first path, the order becomes: 0 → 1 (slim, fed by mock or
integration data) → 3 → 4 → 7 → 5 → 6 → 8, with Phase 2 added once demand is proven. The
per-phase guidance below still applies; only the order changes.

---

## Working method with Claude Code

- Put `CLAUDE.md` in the repo root and `SPEC.md` + this file in `/docs`.
- One phase per git branch (`phase-0-foundation`, `phase-1-slice`, ...).
- Paste prompts one at a time. Review the diff before accepting. Run it. Commit when green.
- When something breaks, paste the **exact error** and ask Claude Code to explain the cause
  before fixing it.
- After finishing a phase, update the "Current phase" line in `CLAUDE.md`.
- If a session goes sideways, `git stash` or reset to your last good commit and restart the
  prompt more narrowly. A fresh, focused prompt beats fighting a confused session.

---

# Phase 0 — Foundation & the data contract

**Goal:** A working monorepo with the shared types defined and nothing else.

**Key ideas**
- The contract (`ActivityEvent`, `DailySummary`) is the single most important artifact in
  the project. Everything imports it from `shared`. Get it right and stable now.
- A monorepo exists so the agent and web app can't drift apart on these types.

**Guiding principles for this phase:** contract-first; build no features yet.

**Prompt**
```
Read CLAUDE.md and docs/SPEC.md. Set up a pnpm workspace monorepo with three
packages: `agent`, `web`, and `shared`. Use TypeScript throughout.

In `shared`, implement ONLY the types from the spec: Category, ActivityEvent,
and DailySummary, cleanly exported and documented with comments. Do not add a
database, API routes, UI, or any features yet.

Then show me the folder structure and confirm that both `agent` and `web` can
import the types from `shared`. Explain the workspace setup in plain English.
```

**Watch-outs**
- Don't let it scaffold features, a database, or auth this phase. If it tries, stop it.
- Keep `shared` tiny — just the types.

**Done when:** `pnpm install` works, `shared` exports the three types, and a throwaway
import of `DailySummary` from both `agent` and `web` compiles.

---

# Phase 1 — Thin vertical slice

**Goal:** Real data flows agent → `/api/ingest` → Supabase → one dashboard page.

**Key ideas**
- This proves the hard part: the pipeline. Everything is intentionally minimal and ugly.
- No categorization, no scoring, no auth, no styling. Just: capture app name → store → show.

**Guiding principles for this phase:** end-to-end before depth; resist the urge to polish.

**Prompts** (do these as three separate steps)
```
[1/3 — backend] In `web`, create a Next.js App Router project. Add a Supabase
client and a single table `raw_events` (id, app_name, started_at, ended_at).
Create POST /api/ingest that validates an ActivityEvent[] with zod and inserts
rows, and GET /api/summary/today that returns total minutes per app for today.
Include a .env.example and tell me exactly what to put in Supabase.
```
```
[2/3 — agent] In `agent`, build a minimal Electron tray app that uses the
`active-win` library to detect the focused app every few seconds, batches them
into ActivityEvent[] (no categorization yet), and POSTs to
http://localhost:3000/api/ingest every 60s. Add a tray icon and a tiny window
showing the app currently being tracked.
```
```
[3/3 — dashboard] Build one Next.js page at /dashboard that fetches
/api/summary/today and renders the focus gauge and hourly bar chart from this
mockup [attach the dashboard widget code from earlier]. Use the real data.
Plain and unstyled is fine.
```

**Watch-outs**
- Localhost connectivity, Supabase keys, and env vars are the usual snags. Paste exact
  errors.
- Keep it ugly on purpose. Polishing now is wasted effort.

**Done when:** you run the agent, work for a few minutes, refresh `/dashboard`, and see your
own real app usage on screen.

---

# Phase 2 — The real agent (the privacy spine)

**Goal:** The agent categorizes, detects idle and focus blocks, aggregates locally, exposes
a Transparency panel, and sends only `DailySummary`.

**Key ideas**
- This is where the privacy architecture becomes real: raw events never leave the machine.
- Focus block = 25+ minutes uninterrupted in a productive category. Idle = no input > 3 min,
  excluded from focus time.
- This is the hardest, slowest phase. Expect OS-specific surprises.

**Guiding principles for this phase:** privacy hard rules above all; aggregate locally;
never capture forbidden data even if it would make a metric "better."

**Prompt**
```
Read CLAUDE.md (the hard privacy rules) and docs/SPEC.md (DailySummary fields).
Extend the agent:
1) Categorize each active app into development / communication / creative /
   admin / browser / other via a config file I can edit.
2) Detect idle (>3 min no input) and exclude it from active/focus time.
3) Detect focus blocks: 25+ min uninterrupted in a productive category.
4) Aggregate everything LOCALLY into a DailySummary and send only that to
   /api/ingest every 15 min. Stop sending raw events.
5) Add a Transparency panel that lists exactly what is collected, plus a
   "mark private" toggle that pauses tracking.

Hard rule: never read or transmit window titles, URLs, keystrokes, or screen
contents. Update /api/ingest to accept DailySummary and upsert into a
daily_summaries table (unique on user_id + date). Explain the focus-block logic.
```

**Watch-outs**
- `active-win` behaves differently on macOS vs Windows; test both early if you can.
- Handle sleep/wake, lock screen, and multiple monitors.
- **Code signing & notarization** (Apple/Microsoft) is a separate task that adds calendar
  time you can't compress. Start it early; it's also what stops antivirus flags.

**Done when:** the only thing hitting your server is a `DailySummary`; the Transparency
panel is accurate; "mark private" pauses tracking; no forbidden field appears anywhere.

---

# Phase 3 — Scoring engine

**Goal:** Pure, tested functions that turn summaries into focus score, peak hours, streaks,
and trends. This powers the **free** tier.

**Key ideas**
- Deterministic and ~$0 to run — this is why the free tier is economically safe.
- The formula in SPEC.md is a starting point; weights get tuned against real data later.

**Guiding principles for this phase:** pure functions + unit tests; free tier = computed
only, no AI.

**Prompt**
```
Read the scoring section of docs/SPEC.md. In web/lib/scoring, implement pure
functions: focusScore (0-100 using the spec's formula), peakHours (top 2-3 from
30 days), currentStreak (consecutive days >= 60), and weekOverWeekTrend. Write
unit tests with sample summaries alongside each function. Handle new users with
no history gracefully. Use the user's local date consistently. Explain the
focus-score formula and any assumptions before implementing.
```

**Watch-outs**
- Timezones: "today" must be the user's local day, not server UTC.
- New users have no 30-day baseline — define sensible defaults.

**Done when:** tests pass, and feeding in a few sample days produces scores that feel right.

---

# Phase 4 — Employee dashboard + auth  *(first demoable milestone)*

**Goal:** The full personal dashboard, wired to real data, behind a login.

**Key ideas**
- Single-player value. After this, you can use Pulse on yourself every day.
- Matches the employee view of the mockup.
- Settings: WorkSchedule UI (working days, daily hours, vacation dates), 
  stored in a user_settings table, loaded by API and passed into scoring.
- Tray polish: direct link to dashboard, tiny daily-score readout, 
  professional icon. Fold into the Phase 4 polish pass.
- Streak UX: show endReason ("ended Tuesday — no data") rather than 
  silent reset.
### Companion widget (Phase 4i)

- The 4h popover is now a PERSISTENT companion, not a transient menu.
  Two dismiss/restore paths only: × button (hidePopover IPC) and tray
  toggle. Every INVOLUNTARY dismiss path was deliberately removed —
  blur-dismiss (base 4i) and Esc-dismiss (popover.js, removed during
  cleanup with an explanatory comment). A screenshot tool emitting Esc
  on teardown was hiding the widget post-capture; that's why Esc-dismiss
  is gone and must not be re-added. The window is demonstrably
  capturable (no setContentProtection anywhere).
- WidgetStateStore (widget-state.ts, mirrors ScoreCache): persists
  {x, y, pinned, compact} in widget-state.json, atomic tmp+rename,
  validator clears corrupt files. `compact` is OPTIONAL and
  backward-compatible — pre-4i files without it load as not-compact.
- Position clamp: clampWidgetIntoView runs against the window's LIVE
  getBounds() at every show AND on every card↔pill resize — never a
  constant, because the frameless-transparent window reports ~345px not
  the 340 constant (invisible DWM border). All clamp coords are
  Math.round'd to whole integers before setBounds (fractional pixels
  render the score blurry).
- Compact mode (card ↔ pill) is PURELY presentational — the tracking
  path (poll → powerMonitor/active-win → sendSummary) reads no window or
  display state, so compact/hidden/full never affects idle/focus
  detection, the flush cycle, or DailySummary. The refresh timer pauses
  while hidden (score only moves on the 15-min flush or another device
  posting); tracking does not.
- Pill chip: solid slate-900 (~90% opaque), 1px rgba(255,255,255,0.22)
  border (reads on light AND dark backgrounds), no backdrop-filter, no
  text-shadow. Score keeps band colors but the slate band (<40) remaps
  to light slate (#cbd5e1) so a low-score day isn't slate-on-slate.
- Launch shows ONLY the widget. The Transparency panel no longer
  auto-creates at startup (removed the createWindow() call in
  app.whenReady()); it's lazily created on the first show-panel footer
  click. show-panel no longer calls popover?.hide() — opening the panel
  does NOT dismiss the persistent widget. The panel stays the privacy
  surface, one obvious click away.
- Unknown-apps classify nudge: count comes from the classifier's local
  unknownQueue (apps past the 10-min unknown threshold), broadcast to the
  widget as classify-nudge {count} — a COUNT ONLY, never app names. The
  nudge opens the existing Transparency-panel classify UI. Classifying
  writes via setOverride → user-overrides.json (userData, writable in
  production), applies live on the next poll, NO restart. categories.json
  is the read-only app-bundle seed (inside the asar when packaged) — never
  a runtime write target. No server call, no new API route, no
  DailySummary change — unclassified app names never leave the machine.
- Service-role surface UNCHANGED this phase: 4i reuses 4h's
  GET /api/agent/today and adds no new server-side surface. The six-entry
  list in the Pairing section still stands.

**Guiding principles for this phase:** build for one user first; clear conventional UI;
protect every data route by the authenticated user.

**Prompt**
```
Add Supabase Auth (email login) to the web app. Build out the full employee
dashboard from this mockup [attach the employee-view widget]: focus gauge, stat
cards, hourly chart, weekly trend, and a placeholder insights section. Wire
every section to real data from the scoring engine and daily_summaries, scoped
to the logged-in user. Make sure the agent's DailySummary is tied to the
authenticated user's account. Make it responsive. Protect all /api routes so a
user can only ever read their own data.
```

**Watch-outs**
- Auth always takes longer than expected. Don't rush the "who owns this row" logic.
- Connect the agent's identity to the account (a device token or login in the agent).

**Done when:** you sign up, the agent ties to your account, and your dashboard shows your
real focus score, hours, chart, and streak.

---

# Phase 5 — AI insights  *(paid feature)*

**Goal:** A nightly job sends each paid user's data to Claude and stores 2–3 supportive
coaching insights.

**Key ideas**
- **Batch API (50% off)** and **prompt caching (90% off cached input)** make this cheap —
  use both. The nightly job isn't latency-sensitive, so batch is ideal.
- Strict JSON schema in, safely parsed out. Supportive coach tone, never punitive.
- **Paid only.** Free users keep computed tips. No LLM in the free path.

**Guiding principles for this phase:** no LLM in the free path; cost discipline (batch +
cache + Haiku for routine insights); parse AI output defensively.



**Prompt**
```
Build the insights worker as a Vercel Cron job. For each PAID user daily, send
their DailySummary + 30-day trends to the Claude API (use Haiku 4.5 via the
batch API, and prompt-cache the system prompt) and request 2-3 actionable,
supportive coaching insights: peak-window suggestions, meeting-load warnings,
streak/achievement callouts. Define a strict JSON schema, parse it safely, and
fall back to computed tips if the call fails or returns invalid JSON. Store
insights and render them in the dashboard cards. Gate this entirely behind a
paid flag. Write the system prompt (encouraging coach, never punitive) and show
it to me before finalizing.
```

**Watch-outs**
- Never trust raw model output — validate JSON, handle failures, fall back gracefully.
- Confirm the paid gate works before going live, or free users will rack up API cost.

**Done when:** a cron run produces stored insights for paid users that render in the cards;
free users see computed tips only; a forced API failure falls back cleanly.

---

# Phase 6 — Manager / team view  *(sellable milestone — start charging)*

**Goal:** Teams, multi-tenancy, aggregate team view, access logging + notification, and
team-level AI insights.

**Key ideas**
- This is the **revenue engine**. The team layer must be genuinely valuable enough that an
  internal champion can sell it upward.
- Aggregates by default. Drilling into an individual writes an `access_logs` row and
  notifies that person — accountability both ways.

**Guiding principles for this phase:** managers see aggregates, not raw logs; log + notify
on individual access; authorization is enforced server-side, never just hidden in the UI.

**Prompt**
```
Add orgs, teams, and roles (member / manager / admin) per docs/SPEC.md. Build
the manager/team view from this mockup [attach the manager-view widget]:
team-level aggregates (avg focus score, meeting load, active streaks) and
per-member cards showing only behavioral metrics — never raw activity logs.
Opening an individual's detail must write an access_logs row and notify that
user. Enforce all authorization server-side with row-level rules: a manager can
only see their own team's aggregates. Add a Claude-generated team-insights
section (praise suggestions, action-needed flags, scheduling tips), paid only.
```

**Watch-outs**
- Authorization is the risk here — verify a manager genuinely cannot reach another team's or
  an individual's raw data, even by editing the URL or calling the API directly.
- Don't forget the notify-on-view flow; it's central to the product's trust story.

**Done when:** a manager sees their team's aggregates and member cards; opening an individual
logs and notifies; no path exposes raw individual activity; team insights render.

---

# Phase 7 — Integrations

**Goal:** Google Calendar via OAuth feeds real meeting minutes into summaries, behind a
pluggable integrations module. *(Pull this forward if going integrations-first.)*

**Key ideas**
- Real meeting load makes the meeting-balance part of the score meaningful.
- Architect for future Jira / Linear / GitHub from the start — one common interface.

**Guiding principles for this phase:** pluggable design; encrypt tokens at rest;
least-privilege OAuth scopes.

**Prompt**
```
Add a Google Calendar integration via OAuth that pulls each user's meeting
minutes into their DailySummary. Architect it as a pluggable `integrations`
module with a common interface so Jira / Linear / GitHub can be added later
without rework. Request the minimum read-only scopes. Encrypt stored tokens at
rest and handle token refresh. Add a Connections page in settings where a user
links and unlinks providers.
```

**Watch-outs**
- Google's OAuth app verification can take calendar time — start the submission early.
- Token refresh and revocation need handling; expired tokens shouldn't break summaries.

**Done when:** a user connects Google Calendar, meeting minutes appear in their summaries and
score, and the Connections page reflects the link.

---

# Phase 8 — Billing, deploy, polish

**Goal:** Stripe per-seat billing, production deployment, monitoring, and CI.

**Key ideas**
- Per-seat, 14-day trial. Paid features (AI insights, team view) gate behind an active
  subscription.
- Watch per-MAU costs (especially auth) as you grow — see SPEC.md economics.

**Guiding principles for this phase:** gate paid features cleanly; observability before
scale; secrets only in env, never in the repo.

**Prompt**
```
Add Stripe per-seat billing: an org subscribes, billed per active seat per
month, with a 14-day trial. Use Stripe webhooks to keep subscription state in
sync, and gate AI insights and the team view behind an active subscription.
Then set up deployment: web + cron on Vercel, database on Supabase. Add Sentry
for error tracking and a basic CI pipeline that runs tests on every push.
Walk me through the production env vars and Stripe webhook setup step by step.
```

**Watch-outs**
- Stripe webhooks and subscription-state edge cases (trial end, cancellation, seat changes)
  are fiddly — test them deliberately.
- Make sure seat counting matches reality so you don't over- or under-bill.

**Done when:** a company can subscribe, seats count correctly, paid features unlock on
payment and lock on cancellation, and the app is live with error tracking and CI.

---

## After you ship

- Start with people you can talk to — your own use, then a handful of friendly companies.
- Tune the scoring weights against how productive people actually felt.
- Revisit the open decisions in SPEC.md: a lighter agent (Tauri/Rust/Go), the
  tasks-completed source for non-PM-tool users, and the org onboarding flow.
- Keep AI strictly out of the free path as you scale, and move per-MAU services (auth) to
  self-hosted before you reach the millions.

## When you get stuck

- Paste the exact error and ask for the cause before the fix.
- If a session is confused, reset to your last good commit and restart with a narrower prompt.
- Ask Claude Code to explain any code you'd be uncomfortable debugging alone — you're
  learning the stack as you build it, and that pays off every later phase.
