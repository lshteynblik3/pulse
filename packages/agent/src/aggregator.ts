import type { Category, DailySummary } from '@pulse/shared';
import type { CanonicalConfig } from './config.js';
import type { ClassificationSource, InternalCategory } from './classifier.js';
import { localHour } from './time.js';

/** A focus block must be at least this many minutes of uninterrupted productive activity. */
export const FOCUS_BLOCK_MINUTES = 25;
const FOCUS_BLOCK_MS = FOCUS_BLOCK_MINUTES * 60 * 1000;

const ALL_CATEGORIES: readonly Category[] = [
  'development',
  'communication',
  'creative',
  'admin',
  'browser',
  'entertainment',
  'other',
];

/** One observed slice of time between two polls. */
export interface Slice {
  /** Wall-clock ms at the start of the interval. */
  startMs: number;
  /** Wall-clock ms at the end of the interval. */
  endMs: number;
  /**
   * Category of the app focused during the slice. May be the internal 'unknown'
   * (genuinely unclassified), which is treated as NEUTRAL — see {@link addSlice}.
   */
  category: InternalCategory;
  /** How the category was decided. Plumbed through for future confidence reporting. */
  source: ClassificationSource;
  /** True if the user was idle (no input > threshold) during the slice. */
  idle: boolean;
}

function zeroCategoryMs(): Record<Category, number> {
  const out = {} as Record<Category, number>;
  for (const c of ALL_CATEGORIES) out[c] = 0;
  return out;
}

function msToMinutes(ms: number): number {
  // Round to 0.1 min to keep the payload tidy.
  return Math.round(ms / 6000) / 10;
}

/**
 * Accumulates time slices for a single LOCAL day into a DailySummary.
 *
 * Privacy: this module only ever sees a category, a duration, and an idle flag —
 * never app/window titles, URLs, or input content.
 *
 * Idle handling: idle slices contribute to nothing (active, focus, category, or
 * hourly totals) and break any open focus run — that's how idle is "excluded
 * from active/focus time."
 *
 * Focus blocks: a run of consecutive active + productive slices. The run stays
 * alive across different productive categories (VS Code -> Figma is fine) and
 * breaks only on an idle slice, an UNKNOWN slice, or a switch to a known
 * non-productive category. When a run ends with >= 25 min accumulated, it counts
 * as one focus block.
 *
 * UNKNOWN slices are NEUTRAL: like idle, they are excluded from active, focus,
 * hourly, and category totals, and they break an open focus block. The whole
 * point of the 'unknown' tier is that an app we can't classify must not be
 * counted against the user — but it also can't credibly extend a deep-work run.
 */
export class DayAggregator {
  readonly date: string;

  private activeMs = 0;
  private focusMs = 0;
  private readonly categoryMs = zeroCategoryMs();
  private readonly hourlyFocusMs: number[] = new Array<number>(24).fill(0);
  /** Internal-only tally of ms by classification source (never transmitted). */
  private readonly sourceMs: Record<ClassificationSource, number> = {
    override: 0,
    canonical: 0,
    heuristic: 0,
    unknown: 0,
  };

  private completedBlockCount = 0;
  private completedBlockMs = 0;

  /** Accumulated ms in the currently-open productive run, or null if none open. */
  private runMs: number | null = null;

  constructor(date: string) {
    this.date = date;
  }

  /**
   * Rebuild an aggregator from a persisted DailySummary (crash/restart
   * recovery). Hydrates the ms counters from the stored minutes — minutes are
   * persisted at 0.1-min precision, so a restart costs at most ~6s per counter.
   *
   * Deliberately lossy bits:
   * - The in-progress focus run is NOT restored (runMs stays null): a restart
   *   legitimately breaks an active block. If the run had already qualified
   *   (>= 25 min), buildSummary banked it into the persisted block totals, so
   *   it isn't lost — it just can't be extended.
   * - The internal source tally isn't persisted; it restarts at zero. It is
   *   diagnostics-only and never transmitted.
   */
  static restore(summary: DailySummary): DayAggregator {
    const agg = new DayAggregator(summary.date);
    agg.activeMs = summary.activeMinutes * 60_000;
    agg.focusMs = summary.focusMinutes * 60_000;
    for (const c of ALL_CATEGORIES) {
      agg.categoryMs[c] = (summary.categoryBreakdown[c] ?? 0) * 60_000;
    }
    for (let h = 0; h < 24; h++) {
      agg.hourlyFocusMs[h] = (summary.hourlyFocusMinutes[h] ?? 0) * 60_000;
    }
    agg.completedBlockCount = summary.focusBlockCount;
    agg.completedBlockMs = summary.focusBlockMinutes * 60_000;
    return agg;
  }

  /** Fold one slice into the day's totals. */
  addSlice(slice: Slice, config: CanonicalConfig): void {
    const durationMs = slice.endMs - slice.startMs;
    if (durationMs <= 0) return;

    if (slice.idle) {
      // Idle: excluded from everything, and interrupts any focus run.
      this.endRun();
      return;
    }

    // Source tally covers all non-idle observed time (including unknown), purely
    // for future "what % of time is high-confidence" reporting. Not transmitted.
    this.sourceMs[slice.source] += durationMs;

    if (slice.category === 'unknown') {
      // Neutral: not active, not focus, not in the breakdown — but it does break
      // an open focus block (locked-in behavior, same neutral treatment as idle).
      this.endRun();
      return;
    }

    // Active time (a known public category).
    this.activeMs += durationMs;
    this.categoryMs[slice.category] += durationMs;

    if (config.isProductive(slice.category)) {
      this.focusMs += durationMs;
      const hour = localHour(new Date(slice.endMs));
      this.hourlyFocusMs[hour] = (this.hourlyFocusMs[hour] ?? 0) + durationMs;
      // Open or extend the current focus run.
      this.runMs = (this.runMs ?? 0) + durationMs;
    } else {
      // Active but non-productive: interrupts any focus run.
      this.endRun();
    }
  }

  /**
   * Explicitly close any open focus run — used by `main` on suspend, lock, day
   * rollover, and pause. Banks the run as a block if it was long enough.
   */
  interrupt(): void {
    this.endRun();
  }

  /**
   * Internal diagnostics: ms observed per classification source so far today.
   * Not part of the DailySummary — plumbed for a future "what % of my time is
   * high-confidence?" readout (Phase 4d territory).
   */
  sourceBreakdownMs(): Readonly<Record<ClassificationSource, number>> {
    return { ...this.sourceMs };
  }

  /** Close the open focus run (if any), banking it as a block when long enough. */
  private endRun(): void {
    if (this.runMs === null) return;
    if (this.runMs >= FOCUS_BLOCK_MS) {
      this.completedBlockCount += 1;
      this.completedBlockMs += this.runMs;
    }
    this.runMs = null;
  }

  /**
   * Produce the DailySummary for this day. Includes the in-progress run if it
   * already qualifies, so a deep-work session in progress is reflected before it
   * formally ends.
   */
  buildSummary(userId: string, agentVersion: string): DailySummary {
    let blockCount = this.completedBlockCount;
    let blockMs = this.completedBlockMs;
    if (this.runMs !== null && this.runMs >= FOCUS_BLOCK_MS) {
      blockCount += 1;
      blockMs += this.runMs;
    }

    const categoryBreakdown = zeroCategoryMs();
    for (const c of ALL_CATEGORIES) categoryBreakdown[c] = msToMinutes(this.categoryMs[c]);

    return {
      userId,
      date: this.date,
      activeMinutes: msToMinutes(this.activeMs),
      focusMinutes: msToMinutes(this.focusMs),
      meetingMinutes: 0, // no calendar integration until Phase 7
      categoryBreakdown,
      focusBlockCount: blockCount,
      focusBlockMinutes: msToMinutes(blockMs),
      hourlyFocusMinutes: this.hourlyFocusMs.map(msToMinutes),
      tasksCompleted: 0, // hardcoded for Phase 2 — no PM integration source yet
      agentVersion,
    };
  }
}
