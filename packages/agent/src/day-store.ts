import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DailySummary } from '@pulse/shared';
import type { SeenApp } from './classifier.js';

/**
 * Crash-safe persistence for the rolling day aggregate.
 *
 * The bug this exists to fix: the rolling DailySummary lived only in memory, so
 * an agent restart reset it to zero and the next flush blindly upserted that
 * zero over the real server row. The store keeps a `current-day.json` snapshot
 * in the Electron userData dir so a restart can resume the day instead of
 * wiping it.
 *
 * Atomicity: every write goes to `current-day.json.tmp` first and is then
 * renamed over the real file. `fs.renameSync` replaces atomically (Windows
 * included), so a kill -9 mid-write leaves either the old complete file or the
 * new complete file — never a torn one.
 *
 * Recovery-pending files: when a prior day's data can't be flushed (server
 * down at startup recovery or at day rollover), the snapshot is parked as
 * `current-day-recovery-pending-<date>.json` instead of being discarded, and
 * retried later. Dates sort lexically, so sorting filenames gives oldest-first.
 *
 * No Electron imports here — the directory is injected, so this is unit-testable
 * with a plain temp dir.
 */

export interface PersistedDay {
  /** The LOCAL calendar day this snapshot belongs to (YYYY-MM-DD). */
  localDate: string;
  /** The full DailySummary as of the last save. summary.date === localDate. */
  summary: DailySummary;
  /**
   * Per-app panel state (unknowns included) so "X min today" survives an agent
   * restart. Local-only — never part of the DailySummary sent to the server.
   * Absent in snapshots written before this field existed.
   */
  seenApps?: SeenApp[];
  /** Last successful flush (ms epoch), so the panel doesn't claim "never" after a restart. */
  lastFlushAt?: number | null;
}

const CURRENT_FILE = 'current-day.json';
const PENDING_PREFIX = 'current-day-recovery-pending-';
const DEBOUNCE_MS = 2_000;

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Light shape check — enough to reject garbage without re-validating every field. */
function isPersistedDay(value: unknown): value is PersistedDay {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as {
    localDate?: unknown;
    summary?: unknown;
    seenApps?: unknown;
    lastFlushAt?: unknown;
  };
  if (typeof v.localDate !== 'string' || !LOCAL_DATE_RE.test(v.localDate)) return false;
  if (typeof v.summary !== 'object' || v.summary === null) return false;
  // Optional fields: absent (pre-upgrade snapshot) is fine, present-but-wrong-type is not.
  if (v.seenApps !== undefined && !Array.isArray(v.seenApps)) return false;
  if (v.lastFlushAt !== undefined && v.lastFlushAt !== null && typeof v.lastFlushAt !== 'number') {
    return false;
  }
  const s = v.summary as { date?: unknown; activeMinutes?: unknown };
  return s.date === v.localDate && typeof s.activeMinutes === 'number';
}

export class DayStore {
  private readonly dir: string;
  private readonly file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private getState: (() => PersistedDay) | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, CURRENT_FILE);
  }

  /** Write `data` as JSON to `target` via tmp-file + atomic rename. */
  private atomicWrite(target: string, data: PersistedDay): void {
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
  }

  /**
   * Load the current-day snapshot, or null if missing or corrupt. A corrupt
   * file is moved aside as `current-day.json.corrupt` (for debugging) rather
   * than deleted, and the day starts fresh.
   */
  load(): PersistedDay | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return null; // no snapshot yet — first run or clean rollover
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPersistedDay(parsed)) return parsed;
    } catch {
      // fall through to quarantine
    }
    try {
      fs.renameSync(this.file, `${this.file}.corrupt`);
      console.error(`day-store: ${CURRENT_FILE} was corrupt — moved aside, starting fresh`);
    } catch {
      // quarantine is best-effort
    }
    return null;
  }

  /**
   * Debounced trailing save (~2s): cheap to call on every aggregator change.
   * The state getter runs at write time, so the freshest state wins.
   */
  scheduleSave(getState: () => PersistedDay): void {
    this.getState = getState;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.getState) this.saveNow(this.getState());
    }, DEBOUNCE_MS);
  }

  /** Write immediately, cancelling any pending debounced write. */
  saveNow(data: PersistedDay): void {
    this.cancelPendingSave();
    this.atomicWrite(this.file, data);
  }

  /** Drop a pending debounced write (e.g. at day rollover, before reset). */
  cancelPendingSave(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Persist the freshest state right now if a save was ever scheduled — used on
   * quit so the snapshot reflects the final poll.
   */
  flushPendingSave(): void {
    if (this.getState) this.saveNow(this.getState());
  }

  // -------------------------------------------------------------------------
  // Recovery-pending files: prior-day data that couldn't be flushed yet.
  // -------------------------------------------------------------------------

  /**
   * Park a day's data for a later retry. One file per date; writing the same
   * date again overwrites (within a day the snapshot only ever grows, so the
   * newer write is a superset).
   */
  writeRecoveryPending(data: PersistedDay): string {
    const target = path.join(this.dir, `${PENDING_PREFIX}${data.localDate}.json`);
    this.atomicWrite(target, data);
    return target;
  }

  /** Absolute paths of all pending files, oldest date first. */
  listRecoveryPending(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.startsWith(PENDING_PREFIX) && n.endsWith('.json'))
      .sort() // ISO dates in the name sort lexically = chronologically
      .map((n) => path.join(this.dir, n));
  }

  /** Parse one pending file, or null if corrupt. */
  readRecoveryPending(file: string): PersistedDay | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isPersistedDay(parsed)) return parsed;
    } catch {
      // fall through
    }
    return null;
  }

  /** Delete a pending file after a successful (or pointless-to-retry) send. */
  removeRecoveryPending(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone is fine
    }
  }

  /** Move a corrupt pending file aside so it stops blocking the retry queue. */
  quarantineRecoveryPending(file: string): void {
    try {
      fs.renameSync(file, `${file}.corrupt`);
    } catch {
      // best-effort
    }
  }
}
