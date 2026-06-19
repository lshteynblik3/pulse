/**
 * Pure collect-side logic: parse one batch result, attribute a whole batch's
 * results to users, and decide what to do with an outstanding batch. The collect
 * route wires Anthropic + Supabase around these; keeping the decisions pure makes
 * them unit-testable without a network or a database.
 */

import type { Insight } from './schema';
import { insightsSchema } from './schema';
import { parseCustomId } from './custom-id';
import { BATCH_WINDOW_MS } from './config';

/** Strip a leading/trailing ```code fence``` if present. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m && m[1] !== undefined) return m[1].trim();
  return trimmed;
}

/**
 * Strip fences UNCONDITIONALLY, then JSON.parse + validate against the frozen
 * schema. Haiku reliably wraps its JSON in code fences (the bench proved it), so
 * collect always strips before parsing. Returns the validated insights, or null
 * on any parse/schema failure (the caller skips + logs that user).
 */
export function parseInsightResult(text: string): Insight[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  const result = insightsSchema.safeParse(parsed);
  return result.success ? result.data.insights : null;
}

/** One Anthropic batch result, flattened for attribution. `ok` is false for a
 *  non-succeeded result (errored/canceled/expired); `text` is the model's reply. */
export interface RawBatchResult {
  customId: string;
  ok: boolean;
  text: string | null;
}

export interface StoredInsight {
  userId: string;
  date: string;
  insights: Insight[];
}

export interface SkippedResult {
  customId: string;
  reason: 'transport' | 'bad-custom-id' | 'parse-or-schema';
}

/**
 * Attribute each batch result to (user, date) and parse it. A per-user failure
 * (non-succeeded result, unparseable custom_id, or bad/invalid JSON) is SKIPPED,
 * never aborting the batch — those users fall through to computed tips at read.
 * Pure and deterministic: the same input always yields the same plan, which is
 * what makes the route's delete-then-insert idempotent.
 */
export function collectBatchResults(results: RawBatchResult[]): {
  stored: StoredInsight[];
  skipped: SkippedResult[];
} {
  const stored: StoredInsight[] = [];
  const skipped: SkippedResult[] = [];

  for (const r of results) {
    if (!r.ok || r.text === null) {
      skipped.push({ customId: r.customId, reason: 'transport' });
      continue;
    }
    const id = parseCustomId(r.customId);
    if (!id) {
      skipped.push({ customId: r.customId, reason: 'bad-custom-id' });
      continue;
    }
    const insights = parseInsightResult(r.text);
    if (!insights) {
      skipped.push({ customId: r.customId, reason: 'parse-or-schema' });
      continue;
    }
    stored.push({ userId: id.userId, date: id.date, insights });
  }

  return { stored, skipped };
}

export type BatchAction = 'collect' | 'expire' | 'wait';

/**
 * What to do with an outstanding batch, given Anthropic's processing status and
 * how long ago we submitted it:
 *  - 'ended'                         -> collect (results are ready)
 *  - not ended, past the 24h window  -> expire (terminal; stop rescanning a stuck
 *                                       batch — its users fall to computed tips)
 *  - not ended, still within 24h     -> wait (leave the row; retry next run)
 */
export function decideBatchAction(processingStatus: string, ageMs: number): BatchAction {
  if (processingStatus === 'ended') return 'collect';
  if (ageMs > BATCH_WINDOW_MS) return 'expire';
  return 'wait';
}
