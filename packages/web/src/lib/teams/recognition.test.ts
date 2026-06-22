import { describe, expect, it } from 'vitest';
import type { Category, DailySummary } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import {
  detectMemberEvents,
  detectTeamRecognition,
  recognitionCardText,
  recognitionNotificationText,
  type RecognitionEvent,
  type RecognitionMember,
} from './recognition';
import { addDays } from '../../../lib/scoring/date-utils';

const DATE = '2026-06-18'; // Thursday

const ZERO: Record<Category, number> = {
  development: 0,
  communication: 0,
  creative: 0,
  admin: 0,
  browser: 0,
  entertainment: 0,
  other: 0,
};

/** A summary whose focus score is tunable via focus/block/meeting minutes. */
function mk(
  date: string,
  { focus = 285, block = 240, meet = 0, active = 300 }: Partial<{ focus: number; block: number; meet: number; active: number }> = {},
): DailySummary {
  const hourly = Array.from({ length: 24 }, () => 0);
  hourly[10] = Math.min(60, Math.round(focus / 4));
  return {
    userId: 'u',
    date,
    activeMinutes: active,
    focusMinutes: focus,
    meetingMinutes: meet,
    categoryBreakdown: { ...ZERO, development: focus },
    focusBlockCount: 5,
    focusBlockMinutes: block,
    hourlyFocusMinutes: hourly,
    tasksCompleted: 0,
    agentVersion: 'test',
  };
}

/** Consecutive daily summaries from `start` for `n` days, each via mk(opts). */
function run(start: string, n: number, opts?: Parameters<typeof mk>[1]): DailySummary[] {
  return Array.from({ length: n }, (_, i) => mk(addDays(start, i), opts));
}

function member(summaries: DailySummary[], over: Partial<RecognitionMember> = {}): RecognitionMember {
  return { recipientId: 'm1', name: 'Alice', summaries, schedule: DEFAULT_SCHEDULE, ...over };
}

const ofType = (events: RecognitionEvent[], t: RecognitionEvent['type']) =>
  events.filter((e) => e.type === t);

describe('detectMemberEvents — streak milestone', () => {
  // 5 consecutive WORKING days with data: Fri 12, Mon 15, Tue 16, Wed 17, Thu 18.
  const fiveWorkingDays = [mk('2026-06-12'), mk('2026-06-15'), mk('2026-06-16'), mk('2026-06-17'), mk('2026-06-18')];

  it('fires on the crossing day (4 → 5), once, keyed to that day', () => {
    const events = ofType(detectMemberEvents(member(fiveWorkingDays), DATE), 'streak-milestone');
    expect(events).toHaveLength(1);
    expect(events[0]!.milestone).toBe(5);
    expect(events[0]!.eventDate).toBe('2026-06-18');
    expect(events[0]!.eventKey).toBe('recognition:streak:5:2026-06-18');
  });

  it('does NOT fire at 4 (never reached the milestone)', () => {
    // Only 4 working days, viewed on Wed 17 → count 4.
    const fourDays = [mk('2026-06-12'), mk('2026-06-15'), mk('2026-06-16'), mk('2026-06-17')];
    const events = ofType(detectMemberEvents(member(fourDays), '2026-06-17'), 'streak-milestone');
    expect(events).toHaveLength(0);
  });

  it('is NOT re-fired while sustained: viewing a day later still shows only the 06-18 crossing', () => {
    // Extend to Fri 19 (a 6-day streak). Window for 06-19 is [06-13..06-19]; the
    // only milestone crossing in it is the 5-day one ON 06-18 — no streak-5 dated 19.
    const sixDays = [...fiveWorkingDays, mk('2026-06-19')];
    const events = ofType(detectMemberEvents(member(sixDays), '2026-06-19'), 'streak-milestone');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventDate).toBe('2026-06-18');
  });
});

describe('detectMemberEvents — personal best', () => {
  // 11 prior moderate days (≥10 history), then a clear best on 06-18.
  const priorModerate = run('2026-06-07', 11, { focus: 210, block: 180 }); // 06-07..06-17

  it('fires on a guarded new best beating the prior best by ≥5', () => {
    const summaries = [...priorModerate, mk('2026-06-18', { focus: 285, block: 240 })];
    const events = ofType(detectMemberEvents(member(summaries), DATE), 'personal-best');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventDate).toBe('2026-06-18');
    expect(events[0]!.eventKey).toBe('recognition:personal-best:2026-06-18');
  });

  it('does NOT fire when the new best clears the prior by under the ≥5 margin', () => {
    // 06-18 only ~1 point above the moderate prior best → below PERSONAL_BEST_MIN_MARGIN.
    const summaries = [...priorModerate, mk('2026-06-18', { focus: 219, block: 180 })];
    const events = ofType(detectMemberEvents(member(summaries), DATE), 'personal-best');
    expect(events).toHaveLength(0);
  });

  it('does NOT fire without enough history (< 10 prior scored days)', () => {
    const summaries = [...run('2026-06-15', 3, { focus: 210, block: 180 }), mk('2026-06-18', { focus: 285, block: 240 })];
    const events = ofType(detectMemberEvents(member(summaries), DATE), 'personal-best');
    expect(events).toHaveLength(0);
  });
});

describe('detectMemberEvents — strong week', () => {
  it('fires on the up-crossing into the top band, once, week-keyed', () => {
    // High working days starting Tue 16 → the 7-day avg first clears 80 on 06-16.
    const summaries = [mk('2026-06-16'), mk('2026-06-17'), mk('2026-06-18')];
    const events = ofType(detectMemberEvents(member(summaries), DATE), 'strong-week');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventDate).toBe('2026-06-16');
    // Keyed to the week's Monday (2026-06-15), so a re-crossing in the week can't dupe.
    expect(events[0]!.eventKey).toBe('recognition:strong-week:2026-06-15');
  });
});

describe('detectMemberEvents — positive-only, no negative signal', () => {
  it('a low / declining member produces NO events at all', () => {
    // All low-focus days: never ≥60, so no streak, no best, no strong week.
    const lowDays = run('2026-06-08', 11, { focus: 30, block: 0 });
    expect(detectMemberEvents(member(lowDays), DATE)).toEqual([]);
  });

  it('an empty member produces no events', () => {
    expect(detectMemberEvents(member([]), DATE)).toEqual([]);
  });
});

describe('detectTeamRecognition — absence is not inferable, no floor', () => {
  it('a 3-member team where 1 has a streak yields exactly 1 event, not 3 cards', () => {
    const streaker = member(
      [mk('2026-06-12'), mk('2026-06-15'), mk('2026-06-16'), mk('2026-06-17'), mk('2026-06-18')],
      { recipientId: 'a', name: 'Alice' },
    );
    const quietLow = member(run('2026-06-08', 11, { focus: 30, block: 0 }), { recipientId: 'b', name: 'Bob' });
    const quietEmpty = member([], { recipientId: 'c', name: 'Cleo' });

    const events = detectTeamRecognition([streaker, quietLow, quietEmpty], DATE);
    // The invariant is NOT "one card per member" — it's that the two quiet members
    // contribute ZERO cards. Only the member with real news appears, so absence
    // (Bob/Cleo) can't be read as a flag.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(new Set(events.map((e) => e.recipientId))).toEqual(new Set(['a']));
  });

  it('recognition WORKS on a sub-3 team (the deliberate no-floor divergence from aggregates)', () => {
    const soloStreaker = member(
      [mk('2026-06-12'), mk('2026-06-15'), mk('2026-06-16'), mk('2026-06-17'), mk('2026-06-18')],
      { recipientId: 'only', name: 'Sol' },
    );
    const events = detectTeamRecognition([soloStreaker], DATE); // a ONE-member team
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.recipientId === 'only')).toBe(true);
    expect(events.some((e) => e.type === 'streak-milestone')).toBe(true);
  });
});

describe('recognition copy — manager vs employee are distinct', () => {
  const event: RecognitionEvent = {
    recipientId: 'a',
    name: 'Alice',
    type: 'streak-milestone',
    eventDate: DATE,
    eventKey: 'recognition:streak:5:2026-06-18',
    milestone: 5,
  };

  it('the manager card names the member and nudges acknowledgement', () => {
    const card = recognitionCardText(event);
    expect(card.title).toContain('Alice');
    expect(`${card.title} ${card.body}`.toLowerCase()).toContain('acknowledg');
  });

  it('the employee notification is celebratory and says they were told — and never names themselves in the third person', () => {
    const note = recognitionNotificationText(event);
    expect(note.body.toLowerCase()).toContain('your manager has been told');
    expect(note.title).not.toContain('Alice'); // it's addressed to them, not about them
  });
});
