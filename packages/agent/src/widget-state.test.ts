import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WidgetStateStore, type WidgetState } from './widget-state';

let dir: string;
let store: WidgetStateStore;

const SAMPLE: WidgetState = {
  pinned: false,
  compact: false,
  card: { x: 1280, y: 640 },
  pill: { x: 1700, y: 980 },
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-widget-state-'));
  store = new WidgetStateStore(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WidgetStateStore', () => {
  it('returns null when no state exists yet', () => {
    expect(store.load()).toBeNull();
  });

  it('round-trips both per-mode positions + flags', () => {
    store.save(SAMPLE);
    expect(store.load()).toEqual(SAMPLE);
  });

  it('round-trips a pinned + compact state', () => {
    const s: WidgetState = { ...SAMPLE, pinned: true, compact: true };
    store.save(s);
    expect(store.load()).toEqual(s);
  });

  it('round-trips null positions (a mode never placed yet → default corner)', () => {
    const s: WidgetState = { pinned: false, compact: false, card: { x: 10, y: 20 }, pill: null };
    store.save(s);
    expect(store.load()).toEqual(s);
  });

  it('preserves an off-screen position verbatim (clamping is the caller’s job)', () => {
    // A position saved on a now-disconnected monitor is stored as-is; main.ts
    // clamps it into a visible work area on restore, NOT this store.
    const s: WidgetState = { ...SAMPLE, pill: { x: 5000, y: 5000 } };
    store.save(s);
    expect(store.load()).toEqual(s);
  });

  // --- Legacy migration (pre-per-mode files had a single top-level x/y) -------

  it('migrates a legacy card position (compact:false) into the card slot', () => {
    const file = path.join(dir, 'widget-state.json');
    fs.writeFileSync(file, JSON.stringify({ x: 100, y: 200, pinned: true, compact: false }));
    expect(store.load()).toEqual({
      pinned: true,
      compact: false,
      card: { x: 100, y: 200 },
      pill: null,
    });
  });

  it('migrates a legacy pill position (compact:true) into the pill slot', () => {
    const file = path.join(dir, 'widget-state.json');
    fs.writeFileSync(file, JSON.stringify({ x: 50, y: 60, pinned: false, compact: true }));
    expect(store.load()).toEqual({
      pinned: false,
      compact: true,
      card: null,
      pill: { x: 50, y: 60 },
    });
  });

  it('treats a legacy file with no compact field as not-compact', () => {
    const file = path.join(dir, 'widget-state.json');
    fs.writeFileSync(file, JSON.stringify({ x: 5, y: 6, pinned: true }));
    expect(store.load()).toEqual({ pinned: true, compact: false, card: { x: 5, y: 6 }, pill: null });
  });

  // --- Corruption / robustness ------------------------------------------------

  it('unreadable JSON loads as null (left in place; a later save overwrites it)', () => {
    // Matches score-cache: a parse failure may be transient, so we don't destroy
    // the file — only a well-formed-but-wrong-shape file is cleared (below).
    const file = path.join(dir, 'widget-state.json');
    fs.writeFileSync(file, '{not json');
    expect(store.load()).toBeNull();
  });

  it('a missing/wrong-typed pin is corrupt → null and removed', () => {
    const file = path.join(dir, 'widget-state.json');
    fs.writeFileSync(file, JSON.stringify({ compact: false, card: null, pill: null }));
    expect(store.load()).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a malformed point drops just that slot, keeping the rest', () => {
    const file = path.join(dir, 'widget-state.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ pinned: false, compact: false, card: { x: 'left', y: 1 }, pill: { x: 9, y: 8 } }),
    );
    expect(store.load()).toEqual({ pinned: false, compact: false, card: null, pill: { x: 9, y: 8 } });
  });

  it('save overwrites atomically (no .tmp left behind)', () => {
    store.save(SAMPLE);
    store.save({ ...SAMPLE, pinned: true });
    expect(store.load()?.pinned).toBe(true);
    expect(fs.existsSync(path.join(dir, 'widget-state.json.tmp'))).toBe(false);
  });

  it('clear removes the state', () => {
    store.save(SAMPLE);
    store.clear();
    expect(store.load()).toBeNull();
  });
});
