import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Category, DailySummary } from '@pulse/shared';
import { DayStore, type PersistedDay } from './day-store.js';
import { DayAggregator } from './aggregator.js';
import { Classifier } from './classifier.js';
import type { CanonicalConfig } from './config.js';

function summaryFor(date: string, overrides: Partial<DailySummary> = {}): DailySummary {
  return {
    userId: 'test-device',
    date,
    activeMinutes: 42,
    focusMinutes: 30,
    meetingMinutes: 0,
    categoryBreakdown: {
      development: 30,
      communication: 8,
      creative: 0,
      admin: 0,
      browser: 4,
      entertainment: 0,
      other: 0,
    },
    focusBlockCount: 1,
    focusBlockMinutes: 27,
    hourlyFocusMinutes: [...new Array<number>(9).fill(0), 15, 15, ...new Array<number>(13).fill(0)],
    tasksCompleted: 0,
    agentVersion: '0.2.0',
    ...overrides,
  };
}

function persistedFor(date: string, overrides: Partial<DailySummary> = {}): PersistedDay {
  return { localDate: date, summary: summaryFor(date, overrides) };
}

describe('DayStore', () => {
  let dir: string;
  let store: DayStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-day-store-'));
    store = new DayStore(dir);
  });

  afterEach(() => {
    store.cancelPendingSave();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no snapshot exists', () => {
    expect(store.load()).toBeNull();
  });

  it('round-trips a snapshot through saveNow/load', () => {
    const data = persistedFor('2026-06-10');
    store.saveNow(data);
    expect(store.load()).toEqual(data);
    // the tmp file must not linger after the atomic rename
    expect(fs.existsSync(path.join(dir, 'current-day.json.tmp'))).toBe(false);
  });

  it('round-trips the optional panel fields (seenApps + lastFlushAt)', () => {
    const data: PersistedDay = {
      ...persistedFor('2026-06-10'),
      seenApps: [
        {
          normalized: 'code',
          displayName: 'Visual Studio Code',
          category: 'development',
          source: 'canonical',
          minutesToday: 12.5,
        },
      ],
      lastFlushAt: 1765400000000,
    };
    store.saveNow(data);
    expect(store.load()).toEqual(data);
    // and a pre-upgrade snapshot without the fields still loads (see round-trip above)
  });

  it('rejects a snapshot whose optional fields have the wrong type', () => {
    fs.writeFileSync(
      path.join(dir, 'current-day.json'),
      JSON.stringify({ ...persistedFor('2026-06-10'), seenApps: 'not-an-array' }),
    );
    expect(store.load()).toBeNull();
  });

  it('quarantines a corrupt snapshot and starts fresh', () => {
    fs.writeFileSync(path.join(dir, 'current-day.json'), '{"truncated mid-wr');
    expect(store.load()).toBeNull();
    expect(fs.existsSync(path.join(dir, 'current-day.json.corrupt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'current-day.json'))).toBe(false);
  });

  it('rejects a snapshot whose summary date disagrees with localDate', () => {
    fs.writeFileSync(
      path.join(dir, 'current-day.json'),
      JSON.stringify({ localDate: '2026-06-10', summary: summaryFor('2026-06-09') }),
    );
    expect(store.load()).toBeNull();
  });

  it('debounced save writes the freshest state after ~2s', async () => {
    let active = 1;
    store.scheduleSave(() => persistedFor('2026-06-10', { activeMinutes: active }));
    active = 2;
    store.scheduleSave(() => persistedFor('2026-06-10', { activeMinutes: active }));
    expect(store.load()).toBeNull(); // nothing written yet
    await new Promise((r) => setTimeout(r, 2300));
    expect(store.load()?.summary.activeMinutes).toBe(2);
  });

  it('cancelPendingSave drops a scheduled write', async () => {
    store.scheduleSave(() => persistedFor('2026-06-10'));
    store.cancelPendingSave();
    await new Promise((r) => setTimeout(r, 2300));
    expect(store.load()).toBeNull();
  });

  it('lists recovery-pending files oldest-first and removes them', () => {
    store.writeRecoveryPending(persistedFor('2026-06-09'));
    store.writeRecoveryPending(persistedFor('2026-06-07'));
    store.writeRecoveryPending(persistedFor('2026-06-08'));

    const files = store.listRecoveryPending();
    expect(files.map((f) => path.basename(f))).toEqual([
      'current-day-recovery-pending-2026-06-07.json',
      'current-day-recovery-pending-2026-06-08.json',
      'current-day-recovery-pending-2026-06-09.json',
    ]);
    const oldest = files[0]!;
    expect(store.readRecoveryPending(oldest)?.localDate).toBe('2026-06-07');

    store.removeRecoveryPending(oldest);
    expect(store.listRecoveryPending()).toHaveLength(2);
  });

  it('quarantined pending files leave the retry queue', () => {
    const file = store.writeRecoveryPending(persistedFor('2026-06-09'));
    fs.writeFileSync(file, 'not json at all');
    expect(store.readRecoveryPending(file)).toBeNull();
    store.quarantineRecoveryPending(file);
    expect(store.listRecoveryPending()).toHaveLength(0);
    expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
  });
});

// End-to-end restart simulation: the seen map is recorded by one Classifier,
// persisted to disk THROUGH DayStore (real JSON serialization), loaded by a
// fresh DayStore, and restored into a fresh Classifier — the exact chain
// main.ts runs across an agent restart. The existing unit tests each covered
// only half of this (in-memory restoreSeen round-trip; JSON round-trip without
// a Classifier), which is how the field failure slipped past them.
describe('restart restore of the seen map (end-to-end)', () => {
  const canonical: CanonicalConfig = {
    productive: new Set<Category>(['development']),
    lookup: (n) => (n === 'slack' ? 'communication' : undefined),
    isProductive: (c) => c === 'development',
  };

  function makeClassifier(dir: string, label: string): Classifier {
    return new Classifier({
      canonical,
      overridesPath: path.join(dir, `overrides-${label}.json`),
      unknownPath: path.join(dir, `unknown-${label}.json`),
      now: () => new Date('2026-06-10T12:00:00.000Z'),
    });
  }

  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-restart-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists seen minutes to current-day.json and a restarted classifier restores them', () => {
    // --- session 1: observe real activity (5s slices, like the real poll loop) ---
    const before = makeClassifier(dir, 'before');
    const slack = before.classify('Slack');
    const mystery = before.classify('MysteryTool');
    for (let i = 0; i < 144; i++) before.recordObservation(slack, 'Slack', 5 / 60); // 12 min
    for (let i = 0; i < 108; i++) before.recordObservation(mystery, 'MysteryTool', 5 / 60); // 9 min

    const store1 = new DayStore(dir);
    store1.saveNow({
      ...persistedFor('2026-06-10'),
      seenApps: before.getSeenSnapshot(),
      lastFlushAt: null,
    });

    // --- "restart": everything in-memory is gone; only the file survives ---
    const store2 = new DayStore(dir);
    const persisted = store2.load();
    expect(persisted).not.toBeNull();
    expect(persisted?.seenApps).toBeDefined();

    const after = makeClassifier(dir, 'after');
    after.restoreSeen(persisted?.seenApps);

    const seen = after.getState().seen;
    const restoredSlack = seen.find((a) => a.normalized === 'slack');
    const restoredMystery = seen.find((a) => a.normalized === 'mysterytool');
    expect(restoredSlack?.minutesToday).toBeCloseTo(12, 5);
    expect(restoredMystery?.minutesToday).toBeCloseTo(9, 5);
    // The unknown's threshold progress survived too: 2 more minutes queue it.
    expect(after.getState().unknownQueue).toHaveLength(0);
    const m2 = after.classify('MysteryTool');
    after.recordObservation(m2, 'MysteryTool', 2);
    expect(after.getState().unknownQueue).toHaveLength(1);
  });

  it('a pre-upgrade snapshot (no seenApps field) restores nothing — documented gap', () => {
    // Snapshots written by a build BEFORE the seenApps field existed load fine
    // (the field is optional) but carry no seen map, so the first restart after
    // upgrading starts the panel at zero. This is the failure observed in the
    // field on 2026-06-10; this test pins the behavior down as by-design.
    const store1 = new DayStore(dir);
    store1.saveNow(persistedFor('2026-06-10')); // no seenApps, like an old build

    const persisted = new DayStore(dir).load();
    expect(persisted).not.toBeNull();
    expect(persisted?.seenApps).toBeUndefined();

    const after = makeClassifier(dir, 'after');
    after.restoreSeen(persisted?.seenApps); // undefined — must be a silent no-op
    expect(after.getState().seen).toHaveLength(0);
  });
});

describe('DayAggregator.restore', () => {
  const config: CanonicalConfig = {
    productive: new Set(['development']),
    lookup: () => undefined,
    isProductive: (c) => c === 'development',
  };

  it('round-trips: restore(buildSummary()) rebuilds the same summary', () => {
    const agg = new DayAggregator('2026-06-10');
    let t = new Date('2026-06-10T10:00:00').getTime();
    // 30 min development (one qualifying focus block) + 5 min browser
    for (let i = 0; i < 360; i++) {
      agg.addSlice(
        { startMs: t, endMs: t + 5000, category: 'development', source: 'canonical', idle: false },
        config,
      );
      t += 5000;
    }
    for (let i = 0; i < 60; i++) {
      agg.addSlice(
        { startMs: t, endMs: t + 5000, category: 'browser', source: 'heuristic', idle: false },
        config,
      );
      t += 5000;
    }
    const before = agg.buildSummary('device-1', '0.2.0');
    const after = DayAggregator.restore(before).buildSummary('device-1', '0.2.0');
    expect(after).toEqual(before);
  });

  it('does not restore the in-progress run: new activity must re-earn a block', () => {
    const agg = new DayAggregator('2026-06-10');
    let t = new Date('2026-06-10T10:00:00').getTime();
    // 30 min development, run still open (never interrupted)
    for (let i = 0; i < 360; i++) {
      agg.addSlice(
        { startMs: t, endMs: t + 5000, category: 'development', source: 'canonical', idle: false },
        config,
      );
      t += 5000;
    }
    // buildSummary banks the qualifying open run into the persisted totals…
    const persisted = agg.buildSummary('device-1', '0.2.0');
    expect(persisted.focusBlockCount).toBe(1);

    // …and after restore, 10 more minutes do NOT extend that run: the restored
    // block survives, but the new short run doesn't qualify on its own.
    const restored = DayAggregator.restore(persisted);
    for (let i = 0; i < 120; i++) {
      restored.addSlice(
        { startMs: t, endMs: t + 5000, category: 'development', source: 'canonical', idle: false },
        config,
      );
      t += 5000;
    }
    restored.interrupt();
    const after = restored.buildSummary('device-1', '0.2.0');
    expect(after.focusBlockCount).toBe(1);
    expect(after.focusBlockMinutes).toBe(persisted.focusBlockMinutes);
    expect(after.focusMinutes).toBe(40); // but the focus time itself all counts
  });
});
