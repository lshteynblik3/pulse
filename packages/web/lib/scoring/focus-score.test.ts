import { describe, it, expect } from 'vitest';
import type { Category, DailySummary } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { focusScore, personalMedian30d } from './focus-score';

const ZERO_BREAKDOWN: Record<Category, number> = {
  development: 0,
  communication: 0,
  creative: 0,
  admin: 0,
  browser: 0,
  entertainment: 0,
  other: 0,
};

/** Minimal DailySummary fixture; override only the fields a test cares about. */
function summary(over: Partial<DailySummary> = {}): DailySummary {
  return {
    userId: 'u1',
    date: '2026-06-09', // a Tuesday (working day)
    activeMinutes: 0,
    focusMinutes: 0,
    meetingMinutes: 0,
    categoryBreakdown: ZERO_BREAKDOWN,
    focusBlockCount: 0,
    focusBlockMinutes: 0,
    hourlyFocusMinutes: Array(24).fill(0),
    tasksCompleted: 0,
    agentVersion: 'test',
    ...over,
  };
}

describe('focusScore', () => {
  it('computes the blended score from the spec formula', () => {
    // fr=300/360=0.8333, bs=180/180=1, mb=1 (<=120), cons=360/360=1
    // 100*(0.45*0.8333 + 0.30*1 + 0.15*1 + 0.10*1) = 100*0.925 = 92.5 -> 93
    const { score, breakdown } = focusScore(
      summary({ activeMinutes: 360, focusMinutes: 300, focusBlockMinutes: 180, meetingMinutes: 60 }),
      360,
    );
    expect(score).toBe(93);
    expect(breakdown.focusRatio).toBeCloseTo(0.8333, 4);
    expect(breakdown.blockScore).toBe(1);
    expect(breakdown.meetingBalance).toBe(1);
    expect(breakdown.consistency).toBe(1);
  });

  it('caps each component at 1.0', () => {
    const { breakdown } = focusScore(
      summary({ activeMinutes: 720, focusMinutes: 999, focusBlockMinutes: 240 }),
      360, // active 720 vs median 360 -> ratio 2, capped to 1
    );
    expect(breakdown.focusRatio).toBe(1);
    expect(breakdown.blockScore).toBe(1);
    expect(breakdown.consistency).toBe(1);
  });

  describe('meetingBalance', () => {
    const mb = (meetingMinutes: number) =>
      focusScore(summary({ meetingMinutes }), null).breakdown.meetingBalance;

    it('is full credit at or below 120 min', () => {
      expect(mb(0)).toBe(1);
      expect(mb(120)).toBe(1);
    });
    it('slides linearly to 0.3 between 120 and 300', () => {
      expect(mb(210)).toBeCloseTo(0.65, 5); // halfway
      expect(mb(300)).toBeCloseTo(0.3, 5);
    });
    it('stays at the 0.3 floor beyond 300', () => {
      expect(mb(301)).toBeCloseTo(0.3, 5);
      expect(mb(600)).toBeCloseTo(0.3, 5);
    });
  });

  it('treats a null or non-positive median as consistency = 1.0 (no baseline)', () => {
    expect(focusScore(summary({ activeMinutes: 30 }), null).breakdown.consistency).toBe(1);
    expect(focusScore(summary({ activeMinutes: 30 }), 0).breakdown.consistency).toBe(1);
  });

  it('consistency penalizes under-baseline days', () => {
    // median 360, activeMinutes 180 -> consistency = 0.5
    const { breakdown } = focusScore(summary({ activeMinutes: 180 }), 360);
    expect(breakdown.consistency).toBe(0.5);
  });

  it('avoids divide-by-zero when activeMinutes is 0', () => {
    const { breakdown } = focusScore(summary({ activeMinutes: 0, focusMinutes: 0 }), 100);
    expect(breakdown.focusRatio).toBe(0);
  });

  it('an empty day with no baseline scores from meeting+consistency defaults only', () => {
    // fr=0, bs=0, mb=1.0, cons=1.0 -> 100*(0.15+0.10) = 25
    expect(focusScore(summary(), null).score).toBe(25);
  });
});

describe('personalMedian30d', () => {
  it('returns null with no history', () => {
    expect(personalMedian30d([])).toBeNull();
  });

  it('returns the single value for one working day', () => {
    expect(personalMedian30d([summary({ date: '2026-06-09', activeMinutes: 200 })])).toBe(200);
  });

  it('is the middle value for an odd count', () => {
    const h = [10, 50, 30].map((m, i) =>
      summary({ date: ['2026-06-08', '2026-06-09', '2026-06-10'][i], activeMinutes: m }),
    );
    expect(personalMedian30d(h)).toBe(30);
  });

  it('averages the two middle values for an even count', () => {
    const dates = ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11'];
    const h = [10, 20, 40, 100].map((m, i) => summary({ date: dates[i], activeMinutes: m }));
    expect(personalMedian30d(h)).toBe(30); // (20 + 40) / 2
  });

  it('excludes weekends — they do not drag the baseline', () => {
    const h = [
      summary({ date: '2026-06-08', activeMinutes: 100 }), // Mon
      summary({ date: '2026-06-09', activeMinutes: 200 }), // Tue
      summary({ date: '2026-06-13', activeMinutes: 0 }), // Sat — excluded
      summary({ date: '2026-06-14', activeMinutes: 0 }), // Sun — excluded
    ];
    expect(personalMedian30d(h)).toBe(150); // median of [100, 200], weekends ignored
  });

  it('excludes vacation days (not counted as zero)', () => {
    const schedule = { ...DEFAULT_SCHEDULE, vacationDates: ['2026-06-10'] };
    const h = [
      summary({ date: '2026-06-08', activeMinutes: 100 }),
      summary({ date: '2026-06-09', activeMinutes: 200 }),
      summary({ date: '2026-06-10', activeMinutes: 0 }), // Wed but on vacation — excluded
    ];
    expect(personalMedian30d(h, schedule)).toBe(150); // median of [100, 200]
  });
});
