/**
 * Team recognition — Phase 6. PURE and unit-tested: detects sparse, POSITIVE-ONLY,
 * event-gated highlights for a manager's team, reusing the SAME scoring the
 * dashboard uses (currentStreak, computeWeekSummary, scoreDay via buildScoredDays)
 * — never a parallel formula, never an LLM. No I/O, no clock; `date` is the
 * manager's client-local day, passed through.
 *
 * POSITIVE-ONLY IS STRUCTURAL. RecognitionEventType has ONLY three members, all
 * good news. There is no negative / "needs-attention" member and no code path that
 * emits anything for a low score, a broken streak, or a declining trend — a
 * reviewer can grep this union and the three detectors and see there is nothing
 * else. A member having a bad week produces an EMPTY event list, never a signal.
 *
 * SPARSE / TRANSITION-GATED. Every event fires on a MILESTONE or TRANSITION, never
 * "this person is good again today", so most members on most days yield zero
 * events. Cards come from this event list, so a member with no event yields no
 * card — absence is the norm, never an inferable flag (see the route + UI).
 */

import type { DailySummary, WorkSchedule } from '@pulse/shared';
import { buildScoredDays, computeWeekSummary, WEEK_WINDOW_DAYS } from '../dashboard/compute';
// currentStreak straight from scoring (like compute.ts) — not re-exported by compute.
import { currentStreak } from '../../../lib/scoring';
import { addDays, dayOfWeek, isWorkingDay } from '../../../lib/scoring/date-utils';

/** Streak lengths worth calling out. Crossing one fires once, on the crossing day. */
export const STREAK_MILESTONES = [5, 10, 20] as const;
/** Trailing days scanned for transitions, so recognition isn't lost if the manager
 *  didn't open /team on the exact crossing day. Reuses the week window for symmetry. */
export const RECOGNITION_WINDOW_DAYS = WEEK_WINDOW_DAYS; // 7
/** A personal best below this raw score isn't celebrated (no "best low day"). */
export const PERSONAL_BEST_MIN_SCORE = 60;
/** Need this many prior scored days before a "best" means anything (no onboarding spam). */
export const PERSONAL_BEST_MIN_HISTORY = 10;
/** A new best must beat the old by at least this much — a 71→72 nudge isn't a milestone. */
export const PERSONAL_BEST_MIN_MARGIN = 5;
/** Week focus score (raw 0–100) at/above this is a standout week. */
export const STRONG_WEEK_BAND = 80;

/** The ONLY recognition event types. All positive. No negative member exists. */
export type RecognitionEventType = 'streak-milestone' | 'personal-best' | 'strong-week';

/** One enrolled member's window, as the loader fetched it (name pre-resolved). */
export interface RecognitionMember {
  recipientId: string;
  /** Display name (or email local-part) — the manager card names the member. */
  name: string;
  /** 122-day fetch window so each scored day gets a full median lookback. */
  summaries: DailySummary[];
  schedule: WorkSchedule;
}

export interface RecognitionEvent {
  recipientId: string;
  name: string;
  type: RecognitionEventType;
  /** The day the event transitioned, "YYYY-MM-DD". */
  eventDate: string;
  /** Idempotency key, unique per recipient — the notifications dedup target. */
  eventKey: string;
  /** Facts for the copy formatters. */
  milestone?: number; // streak-milestone
  score?: number; // personal-best (raw day score) / strong-week (raw week score)
}

/** Monday of the civil week containing `date` (dayOfWeek: 0=Sun…1=Mon…6=Sat). */
function weekStartMonday(date: string): string {
  return addDays(date, -((dayOfWeek(date) + 6) % 7));
}

/**
 * Detect one member's recognition events over the trailing window ending on `date`.
 * Pure; reuses buildScoredDays once, then probes each window day for a transition.
 * Deduped by eventKey (a week-keyed strong-week crossing twice in a week collapses
 * to one).
 */
export function detectMemberEvents(member: RecognitionMember, date: string): RecognitionEvent[] {
  const { summaries, schedule, recipientId, name } = member;
  const scoredDays = buildScoredDays(summaries, schedule, date);
  const scoreByDate = new Map(scoredDays.map((s) => [s.date, s.score] as const));

  const windowStart = addDays(date, -(RECOGNITION_WINDOW_DAYS - 1));
  const days: string[] = [];
  for (let d = windowStart; d <= date; d = addDays(d, 1)) days.push(d);

  const events: RecognitionEvent[] = [];
  const seen = new Set<string>();
  const push = (e: RecognitionEvent) => {
    if (seen.has(e.eventKey)) return;
    seen.add(e.eventKey);
    events.push(e);
  };

  for (const d of days) {
    // ── Streak milestone CROSSED on d: count rose from below M to ≥ M. ──
    const countToday = currentStreak(scoredDays, d, schedule).count;
    const countPrev = currentStreak(scoredDays, addDays(d, -1), schedule).count;
    for (const m of STREAK_MILESTONES) {
      if (countPrev < m && countToday >= m) {
        push({
          recipientId,
          name,
          type: 'streak-milestone',
          eventDate: d,
          eventKey: `recognition:streak:${m}:${d}`,
          milestone: m,
        });
      }
    }

    // ── Personal-best focus day on d: a new best, by a margin, on a working day. ──
    const todayScore = scoreByDate.get(d);
    if (todayScore !== undefined && isWorkingDay(d, schedule)) {
      const prior = scoredDays.filter((s) => s.date < d).map((s) => s.score);
      if (prior.length >= PERSONAL_BEST_MIN_HISTORY && todayScore >= PERSONAL_BEST_MIN_SCORE) {
        const priorBest = Math.max(...prior);
        if (todayScore - priorBest >= PERSONAL_BEST_MIN_MARGIN) {
          push({
            recipientId,
            name,
            type: 'personal-best',
            eventDate: d,
            eventKey: `recognition:personal-best:${d}`,
            score: todayScore,
          });
        }
      }
    }

    // ── Strong-week UP-CROSSING on d: week score crossed into the top band. ──
    const weekToday = computeWeekSummary(summaries, scoredDays, schedule, d).score;
    const weekPrev = computeWeekSummary(summaries, scoredDays, schedule, addDays(d, -1)).score;
    if (
      weekToday !== null &&
      weekToday >= STRONG_WEEK_BAND &&
      (weekPrev === null || weekPrev < STRONG_WEEK_BAND)
    ) {
      // Keyed to the week's Monday so re-crossing within the same week (oscillation)
      // collapses to ONE notification per member per calendar week.
      push({
        recipientId,
        name,
        type: 'strong-week',
        eventDate: d,
        eventKey: `recognition:strong-week:${weekStartMonday(d)}`,
        score: weekToday,
      });
    }
  }

  return events;
}

/** All recognition events across a team's members (manager already excluded upstream). */
export function detectTeamRecognition(members: RecognitionMember[], date: string): RecognitionEvent[] {
  return members.flatMap((m) => detectMemberEvents(m, date));
}

/** Manager-facing card copy — names the member, nudges acknowledgement. */
export function recognitionCardText(e: RecognitionEvent): { title: string; body: string } {
  switch (e.type) {
    case 'streak-milestone':
      return {
        title: `${e.name} is on a ${e.milestone}-day focus streak`,
        body: `${e.milestone} focused days in a row — consider acknowledging it.`,
      };
    case 'personal-best':
      return {
        title: `${e.name} set a personal best`,
        body: `Their most focused day in a long while. A quick word of recognition goes a long way.`,
      };
    case 'strong-week':
      return {
        title: `${e.name} had a standout week`,
        body: `Their week is in the top band of focus — worth calling out.`,
      };
  }
}

/** Employee-facing notification copy — celebratory, and tells them they were shared. */
export function recognitionNotificationText(e: RecognitionEvent): { title: string; body: string } {
  switch (e.type) {
    case 'streak-milestone':
      return {
        title: `You're on a ${e.milestone}-day focus streak!`,
        body: `Great momentum — your manager has been told about your ${e.milestone}-day run.`,
      };
    case 'personal-best':
      return {
        title: `You set a personal best`,
        body: `Your most focused day in a long while — your manager has been told.`,
      };
    case 'strong-week':
      return {
        title: `A standout week`,
        body: `You've been stellar this week — your manager has been told.`,
      };
  }
}
