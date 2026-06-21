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

/**
 * Relative day words. The temporal rule forbids these, but a slip is schema-VALID
 * (it's just text), so nothing else catches it — it's invisible-at-write and
 * wrong-at-read. This is the ONLY grep on the actual stored production output
 * (the bench greps the bench; the computedTips test greps the fallback). Belt-and-
 * suspenders: the prompt can't be made perfectly reliable (re-bench showed 1/30).
 */
const RELATIVE = /\b(today|tomorrow|yesterday)\b/i;

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

/** A batch request's OWN terminal status, as Anthropic reports it per result. */
export type BatchResultStatus = 'succeeded' | 'errored' | 'canceled' | 'expired';

/** One Anthropic batch result, carrying its PER-REQUEST status (the primary
 *  signal) and the model's reply text (present only for a succeeded result). */
export interface RawBatchResult {
  customId: string;
  status: BatchResultStatus;
  text: string | null;
}

export interface StoredInsight {
  userId: string;
  date: string;
  insights: Insight[];
}

export interface SkippedResult {
  customId: string;
  reason: Exclude<BatchResultStatus, 'succeeded'> | 'bad-custom-id' | 'parse-or-schema' | 'relative-word';
}

/**
 * Attribute each batch result to (user, date) and parse it. The PER-REQUEST
 * status is the primary signal: only 'succeeded' is parsed; 'errored' /
 * 'canceled' / 'expired' are skipped under their own status (the batch-level 24h
 * wall-clock in decideBatchAction is just the dead-man's switch, not this). A
 * succeeded result that fails custom_id/JSON/schema is likewise skipped. Every
 * skip is per-user and never aborts the batch — those users fall through to
 * computed tips at read. Pure and deterministic: same input -> same plan, which
 * is what makes the route's delete-then-insert idempotent.
 */
export function collectBatchResults(results: RawBatchResult[]): {
  stored: StoredInsight[];
  skipped: SkippedResult[];
} {
  const stored: StoredInsight[] = [];
  const skipped: SkippedResult[] = [];

  for (const r of results) {
    if (r.status !== 'succeeded') {
      // Per-request terminal failure — skip under its real status, not "transport".
      skipped.push({ customId: r.customId, reason: r.status });
      continue;
    }
    const id = parseCustomId(r.customId);
    if (!id) {
      skipped.push({ customId: r.customId, reason: 'bad-custom-id' });
      continue;
    }
    const insights = r.text === null ? null : parseInsightResult(r.text);
    if (!insights) {
      skipped.push({ customId: r.customId, reason: 'parse-or-schema' });
      continue;
    }
    // Belt-and-suspenders: a relative day word ANYWHERE in the schema-valid set
    // (any insight's title OR body) drops the user's ENTIRE set for the date —
    // they fall to computed tips at read, same as a schema failure. Whole-set,
    // not just the offending insight; matches the bench's whole-output grep.
    if (insights.some((i) => RELATIVE.test(i.title) || RELATIVE.test(i.body))) {
      skipped.push({ customId: r.customId, reason: 'relative-word' });
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
