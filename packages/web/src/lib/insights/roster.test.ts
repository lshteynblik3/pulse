import { describe, it, expect } from 'vitest';
import { selectRoster, type RosterCandidate } from './roster';

const REFERENCE = '2026-06-18';
const FRESHNESS = 2; // cutoff = 2026-06-16

describe('selectRoster — the paid gate + freshness', () => {
  it('EXCLUDES a non-paid user even with a fresh summary (the gate)', () => {
    const candidates: RosterCandidate[] = [
      { userId: 'free-user', isPaid: false, latestSummaryDate: '2026-06-18' },
    ];
    expect(selectRoster(candidates, REFERENCE, FRESHNESS)).toEqual([]);
  });

  it('INCLUDES a paid user with a fresh summary, anchored on that date', () => {
    const candidates: RosterCandidate[] = [
      { userId: 'paid-fresh', isPaid: true, latestSummaryDate: '2026-06-18' },
    ];
    expect(selectRoster(candidates, REFERENCE, FRESHNESS)).toEqual([
      { userId: 'paid-fresh', insightDate: '2026-06-18' },
    ]);
  });

  it('EXCLUDES a paid user whose latest summary is stale (older than the cutoff)', () => {
    const candidates: RosterCandidate[] = [
      { userId: 'paid-stale', isPaid: true, latestSummaryDate: '2026-06-15' },
    ];
    expect(selectRoster(candidates, REFERENCE, FRESHNESS)).toEqual([]);
  });

  it('INCLUDES a paid user exactly on the cutoff boundary (>= cutoff is fresh)', () => {
    const candidates: RosterCandidate[] = [
      { userId: 'paid-boundary', isPaid: true, latestSummaryDate: '2026-06-16' },
    ];
    expect(selectRoster(candidates, REFERENCE, FRESHNESS)).toEqual([
      { userId: 'paid-boundary', insightDate: '2026-06-16' },
    ]);
  });

  it('EXCLUDES a paid user who has never reported (null latest date)', () => {
    const candidates: RosterCandidate[] = [
      { userId: 'paid-empty', isPaid: true, latestSummaryDate: null },
    ];
    expect(selectRoster(candidates, REFERENCE, FRESHNESS)).toEqual([]);
  });

  it('filters a mixed list to only fresh paid users', () => {
    const candidates: RosterCandidate[] = [
      { userId: 'free-fresh', isPaid: false, latestSummaryDate: '2026-06-18' },
      { userId: 'paid-fresh', isPaid: true, latestSummaryDate: '2026-06-17' },
      { userId: 'paid-stale', isPaid: true, latestSummaryDate: '2026-06-01' },
      { userId: 'paid-future', isPaid: true, latestSummaryDate: '2026-06-19' }, // tz ahead of UTC ref
    ];
    expect(selectRoster(candidates, REFERENCE, FRESHNESS)).toEqual([
      { userId: 'paid-fresh', insightDate: '2026-06-17' },
      { userId: 'paid-future', insightDate: '2026-06-19' },
    ]);
  });
});
