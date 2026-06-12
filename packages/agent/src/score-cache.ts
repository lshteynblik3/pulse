import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Tiny disk cache for the popover's last-known server-computed score, so the
 * popover renders INSTANTLY from cache and refreshes in the background.
 *
 * Deliberately a sibling of current-day.json, not a new field inside it:
 * DayStore's validator rejects unknown-typed fields by design, and the score
 * is a different kind of state (server-derived display data, safely losable)
 * from the rolling day (local source of truth, never losable).
 *
 * The score and message are NOT computed here or anywhere agent-side — they
 * arrive finished from /api/agent/today. No PII: identity (email/name) stays
 * memory-only per the 4f rule; a score number and a coach sentence are not it.
 *
 * Same atomic write trick as DayStore (tmp + rename), same injectable dir so
 * it unit-tests with a plain temp directory.
 */

export interface TodayScore {
  /** The LOCAL calendar day the score belongs to (YYYY-MM-DD, agent-local). */
  date: string;
  /** Server-computed focus score; null = no data that day (a real state). */
  score: number | null;
  /** The dashboard's own band copy, verbatim from the server. */
  message: string | null;
  /** Most recent successful agent post across the user's devices (ISO). */
  lastActivityAt: string | null;
  /** When this was fetched (ms epoch) — drives the popover freshness hint. */
  fetchedAt: number;
}

const FILE = 'score-cache.json';
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isTodayScore(value: unknown): value is TodayScore {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof TodayScore, unknown>>;
  if (typeof v.date !== 'string' || !LOCAL_DATE_RE.test(v.date)) return false;
  if (v.score !== null && typeof v.score !== 'number') return false;
  if (v.message !== null && typeof v.message !== 'string') return false;
  if (v.lastActivityAt !== null && typeof v.lastActivityAt !== 'string') return false;
  return typeof v.fetchedAt === 'number';
}

export class ScoreCache {
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, FILE);
  }

  /** The cached score, or null when absent/corrupt (corrupt files are removed). */
  load(): TodayScore | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null; // absent or unreadable — either way, no cache
    }
    if (!isTodayScore(parsed)) {
      this.clear(); // corrupt: a stale wrong-shaped cache is worse than none
      return null;
    }
    return parsed;
  }

  save(value: TodayScore): void {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Cache only — losing it costs one loading state, never data.
      console.error('score-cache: save failed:', err);
    }
  }

  /** Remove the cache (unpair/401: the score belonged to that pairing). */
  clear(): void {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      // Best-effort.
    }
  }
}
