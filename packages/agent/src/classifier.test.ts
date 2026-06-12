import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Category } from '@pulse/shared';
import { normalize } from './normalize.js';
import { matchHeuristic } from './heuristics.js';
import { Classifier, resolveCategory } from './classifier.js';
import type { CanonicalConfig } from './config.js';

/** A small fake canonical map so these tests don't depend on categories.json. */
function fakeCanonical(map: Record<string, Category>): CanonicalConfig {
  const productive = new Set<Category>(['development', 'communication', 'creative']);
  return {
    productive,
    lookup: (n) => map[n],
    isProductive: (c) => productive.has(c),
  };
}

describe('normalize', () => {
  it('lowercases, strips .exe, and removes punctuation/whitespace', () => {
    expect(normalize('Code.exe')).toBe('code');
    expect(normalize('Visual Studio Code')).toBe('visualstudiocode');
    expect(normalize('zoom.us')).toBe('zoomus');
    expect(normalize('ms-teams')).toBe('msteams');
    expect(normalize('Notepad++')).toBe('notepad');
    expect(normalize('1Password')).toBe('1password');
  });
});

describe('matchHeuristic', () => {
  it('classifies common families', () => {
    expect(matchHeuristic('windowsterminal')).toBe('development'); // term
    expect(matchHeuristic('googlechrome')).toBe('browser'); // product-name variant
    expect(matchHeuristic('flstudio')).toBe('creative'); // not development
    expect(matchHeuristic('spotify')).toBe('entertainment');
  });

  it('does NOT match the dropped-token false-positive cases', () => {
    expect(matchHeuristic('barcode')).toBeUndefined(); // bare "code" was dropped
    expect(matchHeuristic('ledgerlive')).toBeUndefined(); // bare "edge" was dropped
    expect(matchHeuristic('search')).toBeUndefined(); // bare "arc" was dropped
    expect(matchHeuristic('digitalclock')).toBeUndefined(); // bare "git" was dropped
  });

  it('would send chatgpt to communication — which is why canonical pins it to dev', () => {
    expect(matchHeuristic('chatgpt')).toBe('communication');
  });
});

describe('resolveCategory (lookup chain precedence)', () => {
  const canonical = fakeCanonical({ slack: 'communication', code: 'development' });

  it('override beats canonical and heuristics', () => {
    const overrides = new Map<string, Category>([['slack', 'other']]);
    expect(resolveCategory('slack', overrides, canonical)).toMatchObject({
      category: 'other',
      source: 'override',
    });
  });

  it('canonical beats heuristics', () => {
    expect(resolveCategory('code', new Map(), canonical)).toMatchObject({
      category: 'development',
      source: 'canonical',
    });
  });

  it('heuristics catch what canonical misses', () => {
    expect(resolveCategory('windowsterminal', new Map(), canonical)).toMatchObject({
      category: 'development',
      source: 'heuristic',
    });
  });

  it('falls through to unknown', () => {
    expect(resolveCategory('totallyobscuretool', new Map(), canonical)).toMatchObject({
      category: 'unknown',
      source: 'unknown',
    });
  });
});

describe('Classifier (live overrides + unknown tracking)', () => {
  function makeClassifier() {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-classifier-'));
    const overridesPath = join(dir, 'overrides.json');
    const unknownPath = join(dir, 'unknown.json');
    const classifier = new Classifier({
      canonical: fakeCanonical({ slack: 'communication' }),
      overridesPath,
      unknownPath,
      now: () => new Date('2026-06-09T12:00:00.000Z'),
    });
    return { classifier, overridesPath, unknownPath, dir };
  }

  it('an override takes effect on the very next classify(), with no restart', () => {
    const { classifier, dir } = makeClassifier();
    try {
      expect(classifier.classify('Slack').source).toBe('canonical');
      classifier.setOverride('slack', 'other');
      const after = classifier.classify('Slack');
      expect(after.category).toBe('other');
      expect(after.source).toBe('override');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces an unknown app only after it crosses the 10-minute threshold', () => {
    const { classifier, dir } = makeClassifier();
    try {
      const c = classifier.classify('MysteryTool');
      expect(c.category).toBe('unknown');

      classifier.recordObservation(c, 'MysteryTool', 6);
      expect(classifier.getState().unknownQueue).toHaveLength(0); // below threshold

      classifier.recordObservation(c, 'MysteryTool', 6); // now 12 min total
      const queue = classifier.getState().unknownQueue;
      expect(queue).toHaveLength(1);
      expect(queue[0]?.normalized).toBe('mysterytool');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists a below-threshold unknown in seen (no blind spot), while the queue stays empty', () => {
    const { classifier, dir } = makeClassifier();
    try {
      const c = classifier.classify('MysteryTool');
      classifier.recordObservation(c, 'MysteryTool', 5);
      const state = classifier.getState();
      expect(state.unknownQueue).toHaveLength(0); // below 10 min — not nagging yet
      const row = state.seen.find((a) => a.normalized === 'mysterytool');
      expect(row?.category).toBe('unknown'); // …but visible in recently-tracked
      expect(row?.minutesToday).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restoreSeen carries per-app minutes across a restart, threshold included', () => {
    const first = makeClassifier();
    const second = makeClassifier();
    try {
      const c = first.classifier.classify('MysteryTool');
      first.classifier.recordObservation(c, 'MysteryTool', 9);
      const snapshot = first.classifier.getSeenSnapshot();

      // "Restart": a fresh classifier rehydrated from the snapshot.
      second.classifier.restoreSeen(snapshot);
      const restored = second.classifier.getState().seen.find((a) => a.normalized === 'mysterytool');
      expect(restored?.minutesToday).toBe(9);
      expect(second.classifier.getState().unknownQueue).toHaveLength(0);

      // 2 more minutes after the restart crosses the day's 10-min threshold.
      const c2 = second.classifier.classify('MysteryTool');
      second.classifier.recordObservation(c2, 'MysteryTool', 2);
      expect(second.classifier.getState().unknownQueue).toHaveLength(1);
    } finally {
      rmSync(first.dir, { recursive: true, force: true });
      rmSync(second.dir, { recursive: true, force: true });
    }
  });

  it('restoreSeen skips malformed entries instead of crashing', () => {
    const { classifier, dir } = makeClassifier();
    try {
      classifier.restoreSeen([
        null,
        { bogus: true },
        { normalized: 'ok', displayName: 'OK', category: 'unknown', source: 'unknown', minutesToday: 3 },
        { normalized: 'bad', displayName: 'Bad', category: 'nonsense', source: 'unknown', minutesToday: 3 },
        { normalized: 'neg', displayName: 'Neg', category: 'unknown', source: 'unknown', minutesToday: -1 },
      ]);
      expect(classifier.getState().seen.map((a) => a.normalized)).toEqual(['ok']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records every unknown to disk (normalized name + counters) even below threshold', () => {
    const { classifier, unknownPath, dir } = makeClassifier();
    try {
      const c = classifier.classify('TinyTool');
      classifier.recordObservation(c, 'TinyTool', 2);
      const persisted = JSON.parse(readFileSync(unknownPath, 'utf8')) as Record<
        string,
        { hitCount: number }
      >;
      expect(persisted['tinytool']?.hitCount).toBeGreaterThan(0);
      // Privacy: the only key is the normalized name, never the display name.
      expect(Object.keys(persisted)).toEqual(['tinytool']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
