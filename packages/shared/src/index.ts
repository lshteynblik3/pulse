/**
 * @pulse/shared — the canonical data contract for Pulse.
 *
 * This file is the single most important artifact in the project. The desktop
 * `agent` and the `web` app both import these types from here so they can never
 * drift apart. Treat changes to these shapes as breaking changes: justify them
 * out loud before editing, and keep this file free of features, I/O, or logic —
 * types only. The source of truth for these shapes is `docs/SPEC.md`
 * ("The data contract"); this file mirrors it exactly.
 *
 * PRIVACY (structural, not optional): Pulse never captures keystrokes,
 * screenshots, window titles, URLs, or message content. The agent aggregates raw
 * activity locally; only a {@link DailySummary} ever leaves the machine. None of
 * the types here may grow a field that would carry forbidden content.
 */

// The scoring contract (Phase 3): WorkSchedule, the function return types, and
// ScoredDay. Kept in a sibling file but re-exported here so consumers import
// everything from "@pulse/shared".
export * from './scoring.js';

/**
 * The fixed set of buckets every tracked application is classified into.
 *
 * Classification happens locally in the agent (Phase 2) from an editable config
 * mapping app names to a category. `'other'` is the catch-all for anything not
 * yet mapped.
 *
 * `'development'`, `'communication'`, and `'creative'` are generally treated as
 * "productive" categories for focus-block detection; the exact policy lives in
 * the agent / scoring engine, not in this type.
 */
export type Category =
  | 'development'
  | 'communication'
  | 'creative'
  | 'admin'
  | 'browser'
  | 'other';

/**
 * A single, contiguous interval the user spent focused on one application.
 *
 * This is the agent's LOCAL raw unit of measurement. ActivityEvents are produced
 * and aggregated entirely on the user's machine and are NEVER transmitted to the
 * backend — only the derived {@link DailySummary} is. They exist in `shared` so
 * the agent and any local tooling agree on the shape.
 *
 * Privacy: an ActivityEvent records only *which app* was focused and *for how
 * long*. It must never carry the window title, document name, URL, typed text,
 * or any screen contents.
 */
export interface ActivityEvent {
  /**
   * Human-readable application name as reported by the OS (e.g. "Visual Studio
   * Code", "Slack", "Google Chrome"). The app name only — never the window title.
   */
  appName: string;

  /** The category this app was classified into (see {@link Category}). */
  category: Category;

  /** When the focus interval began. ISO 8601 timestamp, e.g. "2026-06-07T14:03:00.000Z". */
  startedAt: string;

  /** When the focus interval ended. ISO 8601 timestamp. Must be >= {@link startedAt}. */
  endedAt: string;

  /** True if there was no user input during this window (idle); excluded from active/focus time. */
  idle: boolean;
}

/**
 * The single privacy-safe aggregate that the agent sends to the backend, one per
 * user per local day. This is the ONLY shape that crosses the network.
 *
 * Everything here is already aggregated and stripped of content: counts and
 * minutes, never individual events, titles, or URLs. The scoring engine (Phase 3)
 * derives focus score, peak hours, streaks, and trends from a history of these.
 */
export interface DailySummary {
  /** The account this summary belongs to. Ties the agent's data to an authenticated user. */
  userId: string;

  /**
   * The user's LOCAL calendar day this summary covers, as "YYYY-MM-DD".
   * Always the user's local day, never a server/UTC day, so "today" lines up
   * with how the user actually experienced it.
   */
  date: string;

  /** Total non-idle minutes for the day. */
  activeMinutes: number;

  /** Active minutes spent in productive categories. */
  focusMinutes: number;

  /** Minutes spent in meetings, from a calendar integration (Phase 7); `0` when none connected. */
  meetingMinutes: number;

  /**
   * Total active minutes per category for the day. Keys are every {@link Category};
   * a category with no activity is `0` (not omitted) so consumers never branch on
   * `undefined`.
   */
  categoryBreakdown: Record<Category, number>;

  /** How many distinct 25+ min uninterrupted focus blocks occurred during the day. */
  focusBlockCount: number;

  /** Total minutes spent inside those focus blocks. */
  focusBlockMinutes: number;

  /**
   * Focus minutes bucketed by hour of the user's LOCAL day. Exactly 24 entries:
   * index = hour of day (0–23, where 0 = 00:00–01:00), value = focus minutes in
   * that hour. Powers the dashboard's hourly chart and the peak-hours feature,
   * which sums these across the last 30 daily summaries.
   */
  hourlyFocusMinutes: number[];

  /** Tasks completed, from a PM-tool integration, else self-reported; `0` when unknown. */
  tasksCompleted: number;

  /** Version string of the agent that produced this summary (for debugging / migrations). */
  agentVersion: string;
}
