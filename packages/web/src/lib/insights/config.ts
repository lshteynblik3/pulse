/** Phase 5 insights worker — shared config constants. */

/** Haiku 4.5, chosen via the model bench (claude-haiku-4-5-20251001). */
export const INSIGHTS_MODEL = 'claude-haiku-4-5-20251001';

/** Output cap per user. Insights are 2–3 short cards, so this is generous. */
export const INSIGHTS_MAX_TOKENS = 1024;

/**
 * A paid user must have a daily_summary within this many days of the cron's
 * reference date to be coached. A stale day (agent offline, vacation, brand new
 * with nothing recent) is excluded — we don't coach a 10-day-old day. 2 days is
 * also wide enough to absorb timezone skew between the cron's UTC reference and
 * a user's local summary date.
 */
export const ROSTER_FRESHNESS_DAYS = 2;

/**
 * Anthropic Message Batches finish within 24h. Past that, the collect cron gives
 * up on a still-unfinished batch (marks it 'expired') instead of rescanning it
 * forever — those users fall through to computed tips at read.
 */
export const BATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
