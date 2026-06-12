import { readFileSync } from 'node:fs';
import type { Category } from '@pulse/shared';
import { normalize } from './normalize.js';

const ALL_CATEGORIES: readonly Category[] = [
  'development',
  'communication',
  'creative',
  'admin',
  'browser',
  'entertainment',
  'other',
];

function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (ALL_CATEGORIES as readonly string[]).includes(value);
}

/** Shape of categories.json as authored by the user. */
interface RawConfig {
  productiveCategories?: unknown;
  apps?: Record<string, unknown>;
}

/**
 * The canonical app map (Layer 1) plus the productive-category policy.
 *
 * `lookup` is an EXACT match on the normalized name — it is the high-confidence
 * layer. Anything it misses falls through to heuristics, then to 'unknown'
 * (handled by the classifier, not here).
 */
export interface CanonicalConfig {
  /** Categories that count toward focus time and focus blocks. */
  readonly productive: ReadonlySet<Category>;
  /** Exact canonical category for a normalized app name, or undefined if unmapped. */
  lookup(normalized: string): Category | undefined;
  /** Whether a category counts as productive (focus). */
  isProductive(category: Category): boolean;
}

/**
 * Load and validate categories.json. Keys are normalized on load (so the file
 * stays human-editable with names like "Notepad++" or "zoom.us"); invalid
 * category values are ignored. Restart to reload — no hot-reloading of the
 * canonical file (user overrides DO apply live; see classifier).
 */
export function loadCanonicalConfig(path: string): CanonicalConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RawConfig;

  const productive = new Set<Category>(
    Array.isArray(raw.productiveCategories)
      ? raw.productiveCategories.filter(isCategory)
      : [],
  );

  // Normalized app name -> category. Both keys here and the live owner.name go
  // through normalize(), so they match regardless of .exe / spacing / casing.
  const appToCategory = new Map<string, Category>();
  for (const [appName, category] of Object.entries(raw.apps ?? {})) {
    if (isCategory(category)) {
      appToCategory.set(normalize(appName), category);
    }
  }

  return {
    productive,
    lookup(normalized: string): Category | undefined {
      return appToCategory.get(normalized);
    },
    isProductive(category: Category): boolean {
      return productive.has(category);
    },
  };
}
