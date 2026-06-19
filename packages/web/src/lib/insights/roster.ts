/**
 * Roster selection for the nightly insights batch — the PAID GATE.
 *
 * Pure and unit-tested: the submit cron also filters to is_paid at the query
 * level, but the gate lives here too (defense in depth) so it can be tested
 * without a database. The same is_paid invariant we negative-tested live for the
 * paid-flag column earns the same rigor here.
 *
 * Freshness: a paid user with no recent summary (agent offline, vacation, brand
 * new) has no day to anchor and is excluded — we don't coach a stale day. The
 * insight date for an included user is their most-recent local summary date.
 */

import { addDays } from '../../../lib/scoring/date-utils';

export interface RosterCandidate {
  userId: string;
  isPaid: boolean;
  /** The user's most-recent local summary date (YYYY-MM-DD), or null if none. */
  latestSummaryDate: string | null;
}

export interface RosterEntry {
  userId: string;
  /** The day we coach = the user's most-recent local summary date. */
  insightDate: string;
}

/** The earliest summary date that still counts as "fresh" for `referenceDate`. */
export function rosterCutoff(referenceDate: string, freshnessDays: number): string {
  return addDays(referenceDate, -freshnessDays);
}

/**
 * Who gets an LLM insight tonight: paid users with a summary no older than
 * `freshnessDays` before `referenceDate`. Returns each included user paired with
 * the date to coach (their latest summary date).
 */
export function selectRoster(
  candidates: RosterCandidate[],
  referenceDate: string,
  freshnessDays: number,
): RosterEntry[] {
  const cutoff = rosterCutoff(referenceDate, freshnessDays);
  const roster: RosterEntry[] = [];
  for (const c of candidates) {
    if (!c.isPaid) continue; // paid gate — free users never enter the LLM path
    if (c.latestSummaryDate === null) continue; // never reported anything
    if (c.latestSummaryDate < cutoff) continue; // stale — don't coach an old day
    roster.push({ userId: c.userId, insightDate: c.latestSummaryDate });
  }
  return roster;
}
