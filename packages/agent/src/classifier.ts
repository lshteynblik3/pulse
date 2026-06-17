import { readFileSync, writeFileSync } from 'node:fs';
import type { Category } from '@pulse/shared';
import type { CanonicalConfig } from './config.js';
import { normalize } from './normalize.js';
import { matchHeuristic } from './heuristics.js';

/**
 * Classification, Layers 1–3 with self-correction.
 *
 * Lookup chain (strict order, first hit wins):
 *   1. overrides   — user's manual classifications; win over everything
 *   2. canonical   — exact normalized match in categories.json
 *   3. heuristics  — first matching regex (see heuristics.ts)
 *   4. unknown     — matched nothing; NEUTRAL in scoring (excluded entirely)
 *
 * Privacy: this module only ever handles the normalized application name. It
 * never sees, logs, or persists window titles, URLs, file paths, or content.
 * Persisted files live under the Electron userData dir, never the repo, and the
 * unknown-apps file stores ONLY the normalized name plus counters.
 */

/** Where a classification came from — plumbed through for future confidence UI. */
export type ClassificationSource = 'override' | 'canonical' | 'heuristic' | 'unknown';

/** Public categories plus the agent-internal 'unknown' (never transmitted). */
export type InternalCategory = Category | 'unknown';

export interface Classification {
  normalized: string;
  category: InternalCategory;
  source: ClassificationSource;
}

/** An app seen this session, surfaced to the Transparency panel. */
export interface SeenApp {
  normalized: string;
  /** OS-reported app name (owner.name) — allowed to display; kept in memory only. */
  displayName: string;
  category: InternalCategory;
  source: ClassificationSource;
  minutesToday: number;
}

/** Lifetime counters persisted for each unrecognized app (normalized name only). */
interface UnknownStat {
  firstSeen: string;
  lastSeen: string;
  hitCount: number;
  minutesObserved: number;
}

/** An unknown app must accumulate this many minutes in a day before we ask about it. */
export const UNKNOWN_QUEUE_THRESHOLD_MINUTES = 10;

const VALID_CATEGORIES: readonly Category[] = [
  'development',
  'communication',
  'creative',
  'admin',
  'browser',
  'entertainment',
  'other',
];

export function isAssignableCategory(value: unknown): value is Category {
  return typeof value === 'string' && (VALID_CATEGORIES as readonly string[]).includes(value);
}

const VALID_SOURCES: readonly ClassificationSource[] = [
  'override',
  'canonical',
  'heuristic',
  'unknown',
];

/** Shape check for one persisted seen-app entry (see restoreSeen). */
function isSeenApp(value: unknown): value is SeenApp {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SeenApp>;
  return (
    typeof v.normalized === 'string' &&
    v.normalized.length > 0 &&
    typeof v.displayName === 'string' &&
    (isAssignableCategory(v.category) || v.category === 'unknown') &&
    typeof v.source === 'string' &&
    (VALID_SOURCES as readonly string[]).includes(v.source) &&
    typeof v.minutesToday === 'number' &&
    Number.isFinite(v.minutesToday) &&
    v.minutesToday >= 0
  );
}

/**
 * Pure resolver for the lookup chain. Exposed for unit testing — no I/O, no
 * state. `overrides` is any map-like with `.get(normalized) -> Category`.
 */
export function resolveCategory(
  normalized: string,
  overrides: { get(key: string): Category | undefined },
  canonical: CanonicalConfig,
): Classification {
  const override = overrides.get(normalized);
  if (override) return { normalized, category: override, source: 'override' };

  const canonicalHit = canonical.lookup(normalized);
  if (canonicalHit) return { normalized, category: canonicalHit, source: 'canonical' };

  const heuristicHit = matchHeuristic(normalized);
  if (heuristicHit) return { normalized, category: heuristicHit, source: 'heuristic' };

  return { normalized, category: 'unknown', source: 'unknown' };
}

interface ClassifierOptions {
  canonical: CanonicalConfig;
  overridesPath: string;
  unknownPath: string;
  /** Injectable clock for tests. Defaults to the real time. */
  now?: () => Date;
  thresholdMinutes?: number;
}

export class Classifier {
  private readonly canonical: CanonicalConfig;
  private readonly overridesPath: string;
  private readonly unknownPath: string;
  private readonly now: () => Date;
  private readonly threshold: number;

  /** normalized -> category (the live override map the lookup chain consults). */
  private readonly overrides = new Map<string, Category>();
  /** normalized -> timestamp, persisted alongside overrides. */
  private readonly overrideUpdatedAt = new Map<string, string>();
  /** normalized -> lifetime unknown counters (persisted). */
  private readonly unknownStats = new Map<string, UnknownStat>();
  /** normalized -> what we've seen THIS day (in-memory; reset on rollover). */
  private readonly seen = new Map<string, SeenApp>();

  /** Bumps whenever the panel-visible state changes, so `main` knows to push. */
  private rev = 0;

  constructor(opts: ClassifierOptions) {
    this.canonical = opts.canonical;
    this.overridesPath = opts.overridesPath;
    this.unknownPath = opts.unknownPath;
    this.now = opts.now ?? (() => new Date());
    this.threshold = opts.thresholdMinutes ?? UNKNOWN_QUEUE_THRESHOLD_MINUTES;
    this.loadOverrides();
    this.loadUnknownStats();
  }

  get revision(): number {
    return this.rev;
  }

  /** Resolve a live app name through the chain. No side effects. */
  classify(rawAppName: string): Classification {
    return resolveCategory(normalize(rawAppName), this.overrides, this.canonical);
  }

  /**
   * Fold an observed slice into the seen registry and (for unknowns) the
   * persisted unknown-apps file. `minutes` is the slice duration.
   */
  recordObservation(
    classification: Classification,
    displayName: string,
    minutes: number,
  ): void {
    if (minutes <= 0) return;
    const { normalized, category, source } = classification;

    const existing = this.seen.get(normalized);
    const wasQueued = this.isQueued(existing);
    this.seen.set(normalized, {
      normalized,
      displayName,
      category,
      source,
      minutesToday: (existing?.minutesToday ?? 0) + minutes,
    });
    if (!existing) this.rev++; // a newly-seen app changes the panel list

    if (category === 'unknown') {
      this.bumpUnknownStat(normalized, minutes);
      // Crossing the surfacing threshold is a panel-visible change.
      if (!wasQueued && this.isQueued(this.seen.get(normalized))) this.rev++;
    }
  }

  /**
   * Apply a user classification. Wins over canonical AND heuristics, persists
   * immediately, and updates the in-memory map so the NEXT classify() call for
   * this app reflects it without a restart.
   */
  setOverride(normalized: string, category: Category): void {
    this.overrides.set(normalized, category);
    this.overrideUpdatedAt.set(normalized, this.now().toISOString());
    this.saveOverrides();

    const existing = this.seen.get(normalized);
    if (existing) {
      this.seen.set(normalized, { ...existing, category, source: 'override' });
    }
    this.rev++;
  }

  /** Reset per-day in-memory state on local-day rollover. Overrides persist. */
  resetDay(): void {
    this.seen.clear();
    this.rev++;
  }

  /** Snapshot for the Transparency panel. */
  getState(): { seen: SeenApp[]; unknownQueue: SeenApp[] } {
    const all = [...this.seen.values()];
    // The seen list includes unknowns: a below-threshold unknown app shows in
    // "recently tracked" (marked "needs classification" in the panel) instead
    // of being invisible until it crosses the queue threshold.
    const seen = all.sort((a, b) => b.minutesToday - a.minutesToday);
    const unknownQueue = all
      .filter((a) => this.isQueued(a))
      .sort((a, b) => b.minutesToday - a.minutesToday);
    return { seen, unknownQueue };
  }

  /** Every app seen today, raw — persisted in the day snapshot by `main`. */
  getSeenSnapshot(): SeenApp[] {
    return [...this.seen.values()].map((a) => ({ ...a }));
  }

  /**
   * Rehydrate today's seen map after an agent restart, so per-app minutes (and
   * the unknown-queue threshold) survive. Entries are shape-checked one by one;
   * a malformed entry is skipped, never fatal. Counts as a panel change.
   */
  restoreSeen(apps: unknown): void {
    if (!Array.isArray(apps)) return;
    for (const entry of apps) {
      if (isSeenApp(entry)) this.seen.set(entry.normalized, { ...entry });
    }
    this.rev++;
  }

  private isQueued(app: SeenApp | undefined): boolean {
    return !!app && app.category === 'unknown' && app.minutesToday >= this.threshold;
  }

  private bumpUnknownStat(normalized: string, minutes: number): void {
    const ts = this.now().toISOString();
    const prev = this.unknownStats.get(normalized);
    this.unknownStats.set(normalized, {
      firstSeen: prev?.firstSeen ?? ts,
      lastSeen: ts,
      hitCount: (prev?.hitCount ?? 0) + 1,
      minutesObserved: (prev?.minutesObserved ?? 0) + minutes,
    });
    this.saveUnknownStats();
  }

  // --- persistence (best-effort; a corrupt/missing file just starts empty) ---

  private loadOverrides(): void {
    const data = readJson<Record<string, { category?: unknown; updatedAt?: unknown }>>(
      this.overridesPath,
    );
    if (!data) return;
    for (const [normalized, entry] of Object.entries(data)) {
      if (isAssignableCategory(entry?.category)) {
        this.overrides.set(normalized, entry.category);
        if (typeof entry.updatedAt === 'string') {
          this.overrideUpdatedAt.set(normalized, entry.updatedAt);
        }
      }
    }
  }

  private saveOverrides(): void {
    const out: Record<string, { category: Category; updatedAt: string }> = {};
    for (const [normalized, category] of this.overrides) {
      out[normalized] = {
        category,
        updatedAt: this.overrideUpdatedAt.get(normalized) ?? this.now().toISOString(),
      };
    }
    writeJson(this.overridesPath, out);
  }

  private loadUnknownStats(): void {
    const data = readJson<Record<string, UnknownStat>>(this.unknownPath);
    if (!data) return;
    for (const [normalized, stat] of Object.entries(data)) {
      if (stat && typeof stat.hitCount === 'number') this.unknownStats.set(normalized, stat);
    }
  }

  private saveUnknownStats(): void {
    writeJson(this.unknownPath, Object.fromEntries(this.unknownStats));
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined; // missing or corrupt — caller starts empty
  }
}

function writeJson(path: string, data: unknown): void {
  try {
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to persist ${path}:`, err);
  }
}
