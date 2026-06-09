import type { Category, DailySummary } from '@pulse/shared';
import type { CategoryConfig } from './config.js';
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
  'other',
];

/** One observed slice of time between two polls. */
export interface Slice {
  /** Wall-clock ms at the start of the interval. */
  startMs: number;
  /** Wall-clock ms at the end of the interval. */
  endMs: number;
  /** Category of the app focused during the slice. */
  category: Category;
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
 * breaks only on an idle slice or a switch to a non-productive category. When a
 * run ends with >= 25 min accumulated, it counts as one focus block.
 */
export class DayAggregator {
  readonly date: string;

  private activeMs = 0;
  private focusMs = 0;
  private readonly categoryMs = zeroCategoryMs();
  private readonly hourlyFocusMs: number[] = new Array<number>(24).fill(0);

  private completedBlockCount = 0;
  private completedBlockMs = 0;

  /** Accumulated ms in the currently-open productive run, or null if none open. */
  private runMs: number | null = null;

  constructor(date: string) {
    this.date = date;
  }

  /** Fold one slice into the day's totals. */
  addSlice(slice: Slice, config: CategoryConfig): void {
    const durationMs = slice.endMs - slice.startMs;
    if (durationMs <= 0) return;

    if (slice.idle) {
      // Idle: excluded from everything, and interrupts any focus run.
      this.endRun();
      return;
    }

    // Active time.
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
