import { describe, expect, it } from 'vitest';
import type { Streak } from '@pulse/shared';
import {
  formatDateHeading,
  formatDateShort,
  formatMinutes,
  hourRangeLabel,
  hourTickLabel,
  localDateString,
  percentLabel,
  scoreColor,
  scoreMessage,
  streakMessage,
} from './format';

describe('localDateString', () => {
  it('builds YYYY-MM-DD from LOCAL components, zero-padded', () => {
    // new Date(y, m, d) is a LOCAL construction — this asserts no UTC round-trip,
    // because toISOString() on this value could shift a day in many timezones.
    expect(localDateString(new Date(2026, 5, 11))).toBe('2026-06-11');
    expect(localDateString(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('date headings', () => {
  it('formats the civil date without a UTC parse (2026-06-11 is a Thursday)', () => {
    expect(formatDateHeading('2026-06-11')).toBe('Thursday, June 11');
  });

  it('formats short dates', () => {
    expect(formatDateShort('2026-06-08')).toBe('June 8');
  });
});

describe('formatMinutes', () => {
  it('rounds to the nearest whole minute and picks the compact unit', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(59.6)).toBe('1h'); // rounds up across the hour boundary
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatMinutes(125.4)).toBe('2h 5m');
  });
});

describe('percentLabel', () => {
  it('rounds a 0–1 fraction to a whole percent', () => {
    expect(percentLabel(0.456)).toBe('46%');
    expect(percentLabel(1)).toBe('100%');
    expect(percentLabel(0)).toBe('0%');
  });
});

describe('hour labels', () => {
  it('handles midnight, noon, and the AM/PM crossings', () => {
    expect(hourRangeLabel(0)).toBe('12–1 AM');
    expect(hourRangeLabel(9)).toBe('9–10 AM');
    expect(hourRangeLabel(11)).toBe('11 AM–12 PM');
    expect(hourRangeLabel(12)).toBe('12–1 PM');
    expect(hourRangeLabel(23)).toBe('11 PM–12 AM');
  });

  it('formats axis ticks', () => {
    expect(hourTickLabel(0)).toBe('12 AM');
    expect(hourTickLabel(6)).toBe('6 AM');
    expect(hourTickLabel(12)).toBe('12 PM');
    expect(hourTickLabel(18)).toBe('6 PM');
  });
});

describe('score bands (the coach tone, pinned)', () => {
  it('changes message at the 40/60/80 boundaries', () => {
    expect(scoreMessage(80)).not.toBe(scoreMessage(79));
    expect(scoreMessage(60)).not.toBe(scoreMessage(59));
    expect(scoreMessage(40)).not.toBe(scoreMessage(39));
    expect(scoreMessage(0)).toBe(scoreMessage(39));
  });

  it('never describes a low score as failure', () => {
    for (const score of [0, 15, 39]) {
      const msg = scoreMessage(score).toLowerCase();
      expect(msg).not.toMatch(/fail|bad|poor|behind/);
    }
  });

  it('uses no red at any band', () => {
    for (const score of [0, 39, 40, 59, 60, 79, 80, 100]) {
      expect(scoreColor(score)).not.toMatch(/^#(f|e[0-9a-b]|d[0-9a-b])/i);
    }
    expect(scoreColor(95)).toBe('#1a7f37');
    expect(scoreColor(70)).toBe('#6d4fe5');
  });
});

describe('streakMessage — endReason surfaced in human terms', () => {
  const base: Streak = { count: 0, endedOn: null, endReason: 'no_history' };

  it('covers every endReason', () => {
    expect(streakMessage({ ...base, count: 5, endReason: 'active' })).toContain('Going strong');
    expect(streakMessage({ ...base, endReason: 'no_history' })).toContain('first streak');
    expect(
      streakMessage({ ...base, endedOn: '2026-06-08', endReason: 'low_score' }),
    ).toContain('on June 8');
    expect(
      streakMessage({ ...base, endedOn: '2026-06-08', endReason: 'missing_data' }),
    ).toContain('day without data on June 8');
  });

  it('distinguishes an ongoing streak from a fresh reset for the same reason', () => {
    const ended = { ...base, endedOn: '2026-06-08', endReason: 'low_score' as const };
    expect(streakMessage({ ...ended, count: 3 })).toContain('Counting since');
    expect(streakMessage({ ...ended, count: 0 })).toContain('fresh start');
  });
});
