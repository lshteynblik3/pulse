import { readFileSync } from 'node:fs';
import type { Category } from '@pulse/shared';

const ALL_CATEGORIES: readonly Category[] = [
  'development',
  'communication',
  'creative',
  'admin',
  'browser',
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

/** Loaded, validated config with the lookups the agent needs. */
export interface CategoryConfig {
  /** Categories that count toward focus time and focus blocks. */
  readonly productive: ReadonlySet<Category>;
  /** Map an app name to its category ('other' if unknown). */
  categorize(appName: string): Category;
  /** Whether a category counts as productive (focus). */
  isProductive(category: Category): boolean;
}

/**
 * Load and validate the category config from disk. Unknown apps fall back to
 * 'other'; unknown/invalid category values are ignored. Restart to reload — no
 * hot-reloading in Phase 2.
 */
export function loadCategoryConfig(path: string): CategoryConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RawConfig;

  const productive = new Set<Category>(
    Array.isArray(raw.productiveCategories)
      ? raw.productiveCategories.filter(isCategory)
      : [],
  );

  // Lower-cased app name -> category, for case-insensitive matching.
  const appToCategory = new Map<string, Category>();
  for (const [appName, category] of Object.entries(raw.apps ?? {})) {
    if (isCategory(category)) {
      appToCategory.set(appName.trim().toLowerCase(), category);
    }
  }

  return {
    productive,
    categorize(appName: string): Category {
      return appToCategory.get(appName.trim().toLowerCase()) ?? 'other';
    },
    isProductive(category: Category): boolean {
      return productive.has(category);
    },
  };
}
