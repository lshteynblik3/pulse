/**
 * The strict output schema for a user's nightly coaching insights (Phase 5).
 *
 * This is the contract the LLM worker must produce AND the shape the
 * computed-tips fallback emits — one schema, both paths, so the dashboard
 * renders them identically. Promoted here from the throwaway model bench
 * (packages/web/scripts/insights-bench, on branch phase-5-insights-bench) after
 * it settled the design; this is now the real home.
 *
 * Bounds rationale:
 * - Wrapper OBJECT, not a bare array: top-level objects are what JSON decoders
 *   expect, leave room to add fields later without breaking the contract, and
 *   give the model one unambiguous slot to fill.
 * - type enum = three metrics that each have a DEDICATED input number, so every
 *   insight is grounded and renderable by type. Closed enum => no invented
 *   categories. (`consistency` was dropped during benching: no dedicated input
 *   number, so on thin-data days it free-floated into ungrounded praise.)
 * - title 3–60: 3 rejects empty/"ok"; 60 keeps it a card headline.
 * - body 20–280: 20 rejects a non-answer; 280 keeps it a short supportive nudge
 *   that fits a card and bounds output cost.
 * - 2–3 insights: more than a single tip, but not an overload (and caps cost).
 *
 * The collect cron validates UNCONSTRAINED model output against this with
 * safeParse (after stripping code fences — Haiku reliably fences). A per-user
 * parse/validation failure drops that user to computed tips at read; it never
 * aborts the batch.
 */

import { z } from 'zod';

export const INSIGHT_TYPES = ['peak-window', 'meeting-load', 'streak'] as const;

export type InsightType = (typeof INSIGHT_TYPES)[number];

export const insightSchema = z
  .object({
    type: z.enum(INSIGHT_TYPES),
    title: z.string().min(3).max(60),
    body: z.string().min(20).max(280),
  })
  .strict();

export const insightsSchema = z
  .object({
    insights: z.array(insightSchema).min(2).max(3),
  })
  .strict();

export type Insight = z.infer<typeof insightSchema>;
export type InsightsPayload = z.infer<typeof insightsSchema>;
