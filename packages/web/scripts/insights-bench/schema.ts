/**
 * insights-bench — the strict output schema for nightly coaching insights.
 *
 * THROWAWAY MODEL BENCH (Phase 5 pre-work), not the cron/request path. This is
 * the same schema shape the real worker will use, but the bench validates
 * UNCONSTRAINED model output against it with safeParse — no Anthropic
 * structured-outputs / output_config.format — so each provider is judged on
 * equal footing for raw instruction-following.
 *
 * Bounds rationale (see the PR/plan notes):
 * - Wrapper OBJECT, not a bare array: top-level objects are what JSON-schema
 *   decoders expect, leave room to add fields later without breaking the
 *   contract, and give the model one unambiguous slot to fill.
 * - type enum = three metrics that each have a DEDICATED input number, so every
 *   insight is grounded and renderable by type. Closed enum => no invented
 *   categories. (`consistency` was dropped: it had no dedicated input number, so
 *   on thin fixtures it free-floated into ungrounded praise.)
 * - title 3–60: 3 rejects empty/"ok"; 60 keeps it a card headline.
 * - body 20–280: 20 rejects a non-answer; 280 keeps it a short supportive
 *   nudge that fits a card and bounds output cost.
 * - 2–3 insights: more than a single tip, but not an overload (and caps cost).
 */

import { z } from 'zod';

export const INSIGHT_TYPES = ['peak-window', 'meeting-load', 'streak'] as const;

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
