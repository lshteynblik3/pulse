import { describe, it, expect } from 'vitest';
import { collectBatchResults, decideBatchAction, parseInsightResult, type RawBatchResult } from './collect-parse';
import { BATCH_WINDOW_MS } from './config';

const goodJson = JSON.stringify({
  insights: [
    { type: 'peak-window', title: 'Your mornings', body: 'You focus best before noon — try guarding that window for deep work tomorrow.' },
    { type: 'streak', title: 'Nice run', body: 'You are stringing together strong days — keep showing up and it compounds.' },
  ],
});

describe('parseInsightResult (fence-strip is unconditional)', () => {
  it('parses clean JSON with no fences', () => {
    expect(parseInsightResult(goodJson)).toHaveLength(2);
  });

  it('parses JSON wrapped in ```json fences (Haiku fences every time)', () => {
    expect(parseInsightResult('```json\n' + goodJson + '\n```')).toHaveLength(2);
    expect(parseInsightResult('```\n' + goodJson + '\n```')).toHaveLength(2);
  });

  it('returns null on invalid JSON', () => {
    expect(parseInsightResult('not json at all')).toBeNull();
    expect(parseInsightResult('```json\n{ broken ]\n```')).toBeNull();
  });

  it('returns null on valid JSON that fails the frozen schema', () => {
    expect(parseInsightResult(JSON.stringify({ insights: [{ type: 'consistency', title: 'x', body: 'y' }] }))).toBeNull();
    const oneInsight = { insights: [JSON.parse(goodJson).insights[0]] }; // only 1 (min is 2)
    expect(parseInsightResult(JSON.stringify(oneInsight))).toBeNull();
  });
});

describe('collectBatchResults (per-request status is the primary signal)', () => {
  const uid = 'e4f82d82-1c3a-4b5e-9f01-2a3b4c5d6e7f';

  it('stores a succeeded result attributed to the right (user, date)', () => {
    const { stored, skipped } = collectBatchResults([{ customId: `${uid}__2026-06-15`, status: 'succeeded', text: goodJson }]);
    expect(skipped).toHaveLength(0);
    expect(stored).toEqual([{ userId: uid, date: '2026-06-15', insights: expect.any(Array) }]);
    expect(stored[0]?.insights).toHaveLength(2);
  });

  it('ended batch with a per-request "expired" result: succeeded users store, the expired user gets NO row', () => {
    const results: RawBatchResult[] = [
      { customId: `${uid}__2026-06-15`, status: 'succeeded', text: goodJson },
      { customId: 'other-user__2026-06-16', status: 'succeeded', text: '```json\n' + goodJson + '\n```' },
      { customId: 'expired-user__2026-06-15', status: 'expired', text: null },
    ];
    const { stored, skipped } = collectBatchResults(results);
    expect(stored.map((s) => s.userId).sort()).toEqual([uid, 'other-user'].sort());
    // The expired request is skipped under its OWN status (not "transport"), so it
    // gets no row and falls to computed tips at read.
    expect(skipped).toEqual([{ customId: 'expired-user__2026-06-15', reason: 'expired' }]);
  });

  it('skips a bad/garbled succeeded output and stores the others intact', () => {
    const results: RawBatchResult[] = [
      { customId: `${uid}__2026-06-15`, status: 'succeeded', text: goodJson }, // good
      { customId: 'bad-user__2026-06-15', status: 'succeeded', text: 'garbage' }, // parse fail
      { customId: 'errored-user__2026-06-15', status: 'errored', text: null }, // per-request errored
    ];
    const { stored, skipped } = collectBatchResults(results);
    expect(stored.map((s) => s.userId)).toEqual([uid]);
    expect(skipped.map((s) => s.reason).sort()).toEqual(['errored', 'parse-or-schema']);
  });

  it('is deterministic — same input yields the same plan (data-layer idempotency)', () => {
    const input: RawBatchResult[] = [{ customId: `${uid}__2026-06-15`, status: 'succeeded', text: goodJson }];
    expect(collectBatchResults(input)).toEqual(collectBatchResults(input));
  });
});

describe('decideBatchAction (terminal expiry, never "processing" forever)', () => {
  it("'ended' -> collect (even if old)", () => {
    expect(decideBatchAction('ended', 1000)).toBe('collect');
    expect(decideBatchAction('ended', BATCH_WINDOW_MS + 1)).toBe('collect');
  });

  it('unfinished and younger than 24h -> wait', () => {
    expect(decideBatchAction('in_progress', BATCH_WINDOW_MS - 1)).toBe('wait');
  });

  it('unfinished and older than 24h -> expire', () => {
    expect(decideBatchAction('in_progress', BATCH_WINDOW_MS + 1)).toBe('expire');
    expect(decideBatchAction('canceling', BATCH_WINDOW_MS + 1)).toBe('expire');
  });
});
