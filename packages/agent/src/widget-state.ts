import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Tiny disk store for the draggable widget's window state (4i): the pin-on-top
 * toggle, the compact "pill" flag, and a SEPARATE remembered top-left for each
 * mode — the full card and the tiny pill keep their own positions, so collapsing
 * returns the pill to where you last left it (and vice-versa). Sibling of
 * score-cache.json, same atomic write trick (tmp + rename) and injectable dir.
 *
 * Purely local window chrome — losing it costs one default-positioned launch.
 * Visibility is deliberately NOT stored: the widget always shows on launch.
 */

export interface Point {
  x: number;
  y: number;
}

export interface WidgetState {
  /** Pin-on-top: when true the widget floats above other windows. Default off. */
  pinned: boolean;
  /** Compact "pill" view (score only) vs the full card. Default off. */
  compact: boolean;
  /** Last full-card top-left; null → place at the default corner. */
  card: Point | null;
  /** Last pill top-left; null → place at the default corner. */
  pill: Point | null;
}

const FILE = 'widget-state.json';

/** A finite {x,y} or null — a malformed point loses just that slot, not the file. */
function asPoint(value: unknown): Point | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.x !== 'number' || !Number.isFinite(p.x)) return null;
  if (typeof p.y !== 'number' || !Number.isFinite(p.y)) return null;
  return { x: p.x, y: p.y };
}

export class WidgetStateStore {
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, FILE);
  }

  /** The saved state, or null when absent/corrupt (corrupt files are removed). */
  load(): WidgetState | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null; // absent or unreadable — either way, no saved state
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.clear();
      return null;
    }
    const v = parsed as Record<string, unknown>;
    // The pin flag is the one required core field; without it the file is junk.
    if (typeof v.pinned !== 'boolean') {
      this.clear();
      return null;
    }
    const compact = typeof v.compact === 'boolean' ? v.compact : false;

    // Current shape: explicit per-mode positions.
    if ('card' in v || 'pill' in v) {
      return { pinned: v.pinned, compact, card: asPoint(v.card), pill: asPoint(v.pill) };
    }
    // Legacy shape (pre-per-mode): a single top-level x/y belonged to whichever
    // mode was active when it was saved. Migrate it into that mode's slot.
    const legacy = asPoint(v);
    if (legacy) {
      return {
        pinned: v.pinned,
        compact,
        card: compact ? null : legacy,
        pill: compact ? legacy : null,
      };
    }
    // Valid flags, no usable position — both default.
    return { pinned: v.pinned, compact, card: null, pill: null };
  }

  save(value: WidgetState): void {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Window chrome only — losing it costs one default-positioned launch.
      console.error('widget-state: save failed:', err);
    }
  }

  clear(): void {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      // Best-effort.
    }
  }
}
