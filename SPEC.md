# Pulse — Technical Spec

## What we're building

Pulse is a privacy-first productivity coaching tool — "Whoop for work." A lightweight
desktop agent runs on each employee's computer and measures focus patterns. Employees get
a personal coach (focus score, peak hours, streaks, smart suggestions). Managers get
team-level trends and recognition prompts — never individual surveillance.

The whole product premise depends on it feeling supportive, not creepy. That is an
architectural decision, not a marketing one. See "Privacy guarantees" below — those are
hard rules, not preferences.

---

## Core principles

1. **The employee owns their data first.** The dashboard is built for them; the manager
   view is a side effect.
2. **Aggregate on the device.** Raw activity never leaves the machine. The server only
   ever receives a daily summary.
3. **Measure outputs and patterns, not inputs.** Focus time and task completion — never
   keystrokes, screen content, or which websites someone visited.
4. **Accountability flows both ways.** When a manager views an individual's detail, the
   employee is notified.

---

## System components & data flow

```
[Desktop Agent]  -- one per employee machine
   watches active app -> categorizes -> detects idle + focus blocks
   -> aggregates LOCALLY into a DailySummary
        |
        |  HTTPS POST (DailySummary only — never raw events)
        v
[Next.js app]  -- dashboard + API in one deployable
   /api/ingest        receives & validates DailySummary
   /api/summary       serves computed data to the dashboard
   scoring engine     pure functions: focus score, peak hours, streaks, trends
   /dashboard         employee view + manager view
        |
        v
[Supabase Postgres]   stores summaries, scores, insights, users/teams/orgs
        ^
        |
[Vercel Cron] -> nightly job -> Claude API -> writes coaching insights
        ^
        |
[Integrations] (later) Google Calendar etc. -> feeds meeting time into summaries
```

Supporting services: Supabase Auth (login), Stripe (per-seat billing), Anthropic (insights).

---

## The data contract

This is the spine of the system. Define it first, keep it stable, everything depends on it.
Lives in the `shared` package and is imported by both `agent` and `web`.

```ts
type Category =
  | 'development' | 'communication' | 'creative'
  | 'admin' | 'browser' | 'other';

// Lives ONLY on the agent. Never sent to the server in raw form.
interface ActivityEvent {
  appName: string;
  category: Category;
  startedAt: string;   // ISO timestamp
  endedAt: string;     // ISO timestamp
  idle: boolean;       // true if no input during the window
}

// The ONLY thing the agent sends to the server.
interface DailySummary {
  userId: string;
  date: string;                              // YYYY-MM-DD, user's local date
  activeMinutes: number;                     // non-idle minutes
  focusMinutes: number;                      // active minutes in productive categories
  meetingMinutes: number;                    // from calendar integration, else 0
  categoryBreakdown: Record<Category, number>; // minutes per category
  focusBlockCount: number;                   // # of 25+ min uninterrupted blocks
  focusBlockMinutes: number;                 // total minutes inside those blocks
  hourlyFocusMinutes: number[];              // length 24, index = local hour (0–23), focus min that hour
  tasksCompleted: number;                    // from PM integration, else self-reported
  agentVersion: string;
}
```

### Database tables (Supabase Postgres)

- `orgs` — id, name, created_at
- `teams` — id, org_id, name
- `users` — id, org_id, team_id, email, display_name, role (`member` | `manager` | `admin`)
- `daily_summaries` — all DailySummary fields, including `hourly_focus_minutes`
  (`int[]` or `jsonb`, length 24, local hour 0–23); **unique (user_id, date)**
- `scores` — user_id, date, focus_score, peak_hours (jsonb), streak_days
- `insights` — id, user_id, date, type, title, body, created_at
- `integrations` — id, user_id, provider, encrypted_token
- `access_logs` — id, manager_id, viewed_user_id, viewed_at  (powers the both-ways
  accountability notification)

Plain Postgres with an index on `(user_id, date)` is fine for the MVP. Add the TimescaleDB
extension later only if time-range queries get slow.

---

## Privacy guarantees (HARD RULES)

**Collected:** active app name + category, active vs idle time, focus block timing,
meeting minutes (calendar), task counts (PM tools).

**NEVER collected:** keystrokes, screen contents/screenshots, window titles, URLs or
browsing history, message or document contents, mouse-movement logging, webcam/mic.

**Server only ever stores DailySummary** — aggregated, no per-app timestamps tied to
content. The agent ships a Transparency panel listing exactly what's collected and a
"mark private" toggle that pauses tracking. Managers see team aggregates by default;
opening an individual writes an `access_logs` row and notifies that user.

---

## Scoring approach (starting formula — calibrate with real data)

Focus Score is 0–100, blended from four explainable parts:

```
focusRatio     = min(focusMinutes / max(activeMinutes, 1), 1)        // weight 0.45
blockScore     = min(focusBlockMinutes / 180, 1)                     // weight 0.30  (caps at 3h deep work)
meetingBalance = 1.0 if meetingMinutes <= 120,                       // weight 0.15
                 else linearly down to 0.3 at 300+ minutes
consistency    = min(activeMinutes / personalMedian30d, 1)           // weight 0.10  (rewards showing up)

focusScore = round(100 * (0.45*focusRatio + 0.30*blockScore
                        + 0.15*meetingBalance + 0.10*consistency))
```

- **Peak hours:** sum each daily summary's `hourlyFocusMinutes` across the last 30 days
  (element-wise, by local hour) and surface the top 2–3 hours.
- **Streak:** consecutive days with focusScore >= 60.
- Weights are guesses. Once you have a few weeks of real data, tune them so the score
  matches how productive people actually *felt*.

---

## Stack (lean solo version)

- **Monorepo:** pnpm workspaces — packages: `agent`, `web`, `shared`
- **Agent:** Electron + `active-win` for focus detection
- **App (dashboard + API):** Next.js (App Router), hosted on Vercel
- **DB + Auth:** Supabase
- **Scheduled jobs:** Vercel Cron
- **Insights:** Anthropic Claude API
- **Billing:** Stripe (per-seat, 14-day trial)

---

## Build phases

0. Scaffolding + the data contract (`shared` types)
1. Thin vertical slice: minimal agent -> /api/ingest -> one dashboard page with real data
2. Real agent: categorization, idle detection, focus blocks, local aggregation, Transparency panel
3. Scoring engine (pure functions + tests)
4. Full employee dashboard + auth
5. AI insights (Vercel Cron -> Claude API)
6. Manager / team view (aggregates + access logging)
7. Integrations (Google Calendar first)
8. Stripe billing + deploy + error tracking

Demoable to one user after Phase 4. Demoable to a team after Phase 6 — start customer
conversations there, before building integrations and billing.

---

## Decisions still open

- WorkSchedule: per-user working days, daily hours, vacation dates, 
  breaks. Threaded through scoring from Phase 3. Settings UI + storage 
  in Phase 4.
- Adaptive scoring weights per user: drift weights with usage vs explicit 
  archetypes (maker / manager / mixed). Defer until ≥4 weeks of real data 
  from a handful of users — drifting weights silently makes scores opaque, 
  which works against the product's trust story. Revisit post-Phase 6.
- Streak grace policy: currently 1 forgiven missed working day per rolling 
  14-working-day window. Revisit once agent reliability is known.

- Agent long-term: stay on Electron, or rewrite in Tauri/Rust/Go for a smaller footprint
  before scaling to thousands of machines?
- Tasks-completed source for users whose work isn't in a PM tool (self-report UI?)
- Org onboarding flow: admin invites team, or self-serve signup + claim domain?
