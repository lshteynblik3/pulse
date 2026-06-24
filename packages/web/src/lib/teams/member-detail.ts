/**
 * Manager drill-in detail — Phase 6. PURE and unit-tested. Assembles the ONE
 * individual-detail payload a manager may see for a member of their team, reusing
 * the member's OWN compute path (scoreDay → the same breakdown the employee's
 * dashboard shows) so the manager sees the member's ACTUAL numbers, never a
 * parallel computation that could drift.
 *
 * STRUCTURAL EXCLUSIONS (the privacy boundary lives here, in one tested place):
 * the payload is assembled FIELD-BY-FIELD — the raw DailySummary is never spread —
 * so the per-app categoryBreakdown, tasksCompleted, etc. cannot leak. And the
 * Phase-5 coaching insights are NEVER read or referenced here: a manager sees
 * positive strengths, never the employee's private corrective coaching.
 *
 * No I/O, no clock — `date` is the manager's client-local day, passed through.
 */

import type { DailySummary, ScoreBreakdown, WorkSchedule } from '@pulse/shared';
import { scoreDay } from '../dashboard/compute';
import { displayScore } from '../dashboard/format';
import { isWorkingDay } from '../../../lib/scoring/date-utils';
import { detectMemberEvents } from './recognition';

/** The member's focus shape for the day — focus fields only, no category data. */
export interface MemberFocusDetail {
  focusMinutes: number;
  focusBlockCount: number;
  focusBlockMinutes: number;
  hourlyFocusMinutes: number[];
}

export interface MemberDetailPayload {
  date: string;
  name: string;
  /** A non-working day shows no score (a score there reads as judgment) — like the dashboard. */
  isWorkingDay: boolean;
  /** True iff the member reported a summary for `date`. */
  hasData: boolean;
  /** Raw 0–100; null on a non-working day or with no data. */
  score: number | null;
  /** The /130 number to SHOW; null when score is. */
  displayScore: number | null;
  /** The four explainable components; null when there's no score. */
  breakdown: ScoreBreakdown | null;
  /** Focus shape; null when the member has no summary for the day. */
  focus: MemberFocusDetail | null;
  /** Positive "what's working" lines — strictly strengths, never corrective coaching. [] when nothing notable. */
  strengths: string[];
}

export interface MemberDetailInput {
  /** Display name (or email local-part) — resolved by the route. */
  name: string;
  /** 122-day fetch window so the score gets a full median lookback. */
  summaries: DailySummary[];
  schedule: WorkSchedule;
}

/** Positive phrasing for the strongest single component — the no-event fallback. */
function strongestComponentStrength(b: ScoreBreakdown): string {
  const entries: [keyof ScoreBreakdown, number, string][] = [
    ['focusRatio', b.focusRatio, 'Most of their active time went to focused work.'],
    ['blockScore', b.blockScore, 'Strong, sustained deep-work blocks.'],
    ['meetingBalance', b.meetingBalance, 'A well-protected calendar — meetings in balance.'],
    ['consistency', b.consistency, 'Showing up consistently, day over day.'],
  ];
  return entries.reduce((best, e) => (e[1] > best[1] ? e : best))[2];
}

/**
 * Positive strengths for the day. Reuses the recognition POSITIVE detectors
 * (streak / personal-best / strong-week) — the same good-news engine the team view
 * uses — and falls back to the day's strongest score component. NEVER the
 * corrective coaching path (insights / computedTips).
 */
export function memberStrengths(input: MemberDetailInput, date: string, breakdown: ScoreBreakdown | null): string[] {
  const events = detectMemberEvents(
    { recipientId: '', name: input.name, summaries: input.summaries, schedule: input.schedule },
    date,
  );
  const fromEvents = events.map((e) => {
    switch (e.type) {
      case 'streak-milestone':
        return `On a ${e.milestone}-day focus streak.`;
      case 'personal-best':
        return 'Just set a personal best for focus.';
      case 'strong-week':
        return 'Having a standout week.';
    }
  });
  // De-dupe identical phrases (e.g. two strong-week crossings collapsed upstream already).
  const unique = [...new Set(fromEvents)];
  if (unique.length > 0) return unique;
  // No notable event: name the strongest component, but only when there IS a score.
  return breakdown ? [strongestComponentStrength(breakdown)] : [];
}

/**
 * Assemble the member-detail payload for `date`. score/breakdown are suppressed on
 * a non-working day (mirroring the dashboard); focus detail shows whenever there's
 * a summary (a worked day off still shows the work, just no score).
 */
export function buildMemberDetail(input: MemberDetailInput, date: string): MemberDetailPayload {
  const { name, summaries, schedule } = input;
  const working = isWorkingDay(date, schedule);
  const todaySummary = summaries.find((s) => s.date === date) ?? null;

  const scored = working && todaySummary ? scoreDay(todaySummary, summaries, schedule) : null;
  const breakdown = scored ? scored.breakdown : null;

  return {
    date,
    name,
    isWorkingDay: working,
    hasData: todaySummary !== null,
    score: scored ? scored.score : null,
    displayScore: scored ? displayScore(scored.score) : null,
    breakdown,
    // Field-by-field — NEVER spread todaySummary, so categoryBreakdown/tasksCompleted can't leak.
    focus: todaySummary
      ? {
          focusMinutes: todaySummary.focusMinutes,
          focusBlockCount: todaySummary.focusBlockCount,
          focusBlockMinutes: todaySummary.focusBlockMinutes,
          hourlyFocusMinutes: todaySummary.hourlyFocusMinutes,
        }
      : null,
    strengths: memberStrengths(input, date, breakdown),
  };
}
