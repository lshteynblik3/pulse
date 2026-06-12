import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScoreCache, type TodayScore } from './score-cache';

let dir: string;
let cache: ScoreCache;

const SAMPLE: TodayScore = {
  date: '2026-06-12',
  score: 67,
  message: 'A solid, focused day. Nice work.',
  lastActivityAt: '2026-06-12T14:55:00.000Z',
  fetchedAt: 1_750_000_000_000,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-score-cache-'));
  cache = new ScoreCache(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ScoreCache', () => {
  it('returns null when no cache exists yet', () => {
    expect(cache.load()).toBeNull();
  });

  it('round-trips a saved score', () => {
    cache.save(SAMPLE);
    expect(cache.load()).toEqual(SAMPLE);
  });

  it('round-trips the no-data-today shape (nulls are values, not corruption)', () => {
    const empty: TodayScore = { ...SAMPLE, score: null, message: null, lastActivityAt: null };
    cache.save(empty);
    expect(cache.load()).toEqual(empty);
  });

  it('a corrupt file loads as null and is removed', () => {
    const file = path.join(dir, 'score-cache.json');
    fs.writeFileSync(file, '{not json');
    expect(cache.load()).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ date: 'yesterday', score: 'high' }));
    expect(cache.load()).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects a present-but-wrong-typed field', () => {
    cache.save({ ...SAMPLE, score: '67' as unknown as number });
    expect(cache.load()).toBeNull();
  });

  it('save overwrites atomically (no .tmp left behind)', () => {
    cache.save(SAMPLE);
    cache.save({ ...SAMPLE, score: 81 });
    expect(cache.load()?.score).toBe(81);
    expect(fs.existsSync(path.join(dir, 'score-cache.json.tmp'))).toBe(false);
  });

  it('clear removes the cache', () => {
    cache.save(SAMPLE);
    cache.clear();
    expect(cache.load()).toBeNull();
  });
});
