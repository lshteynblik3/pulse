import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import type { DailySummary } from '@pulse/shared';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getWorkSchedule } from '@/lib/work-schedule/loader';
import { fetchWindowStart } from '@/lib/dashboard/compute';
import { SYSTEM_PROMPT, buildInsightsUserMessage } from '@/lib/insights/prompt';
import { buildDayInsightContext } from '@/lib/insights/context';
import { buildCustomId } from '@/lib/insights/custom-id';
import { rosterCutoff, selectRoster, type RosterCandidate } from '@/lib/insights/roster';
import { INSIGHTS_MODEL, INSIGHTS_MAX_TOKENS, ROSTER_FRESHNESS_DAYS } from '@/lib/insights/config';

/**
 * GET /api/cron/insights/submit — the nightly SUBMIT half of the Phase 5 insights
 * worker. Builds one Anthropic Message Batch (Haiku 4.5) of coaching prompts for
 * paid users with a fresh summary, submits it, and records the batch id in
 * insight_batches. The COLLECT cron (separate route) fetches the results later —
 * splitting the work in two is what keeps each invocation under Vercel's function
 * timeout (a batch can take up to 24h to finish).
 *
 * Batch API only (50% off, latency-insensitive). Prompt caching does NOT fire:
 * the ~400-token coach prompt is below Haiku's 4096-token cache minimum, so this
 * gets the batch discount only — expected, not a bug.
 *
 * Gated to is_paid users (no LLM in the free path): the query filters to paid,
 * and selectRoster enforces the gate again (defense in depth, unit-tested).
 *
 * Service-role throughout (no session exists in a cron); protected by CRON_SECRET
 * so only Vercel's scheduler (which sends `Authorization: Bearer <CRON_SECRET>`)
 * can trigger this paid, service-role route.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** A daily_summaries row as supabase-js returns it (snake_case). Mirrors the
 *  mapper in /api/dashboard; a later refactor could share one copy. */
interface DailySummaryRow {
  user_id: string;
  date: string;
  active_minutes: number;
  focus_minutes: number;
  meeting_minutes: number;
  category_breakdown: DailySummary['categoryBreakdown'];
  focus_block_count: number;
  focus_block_minutes: number;
  hourly_focus_minutes: number[];
  tasks_completed: number;
  agent_version: string;
}

function rowToSummary(row: DailySummaryRow): DailySummary {
  return {
    userId: row.user_id,
    date: row.date,
    activeMinutes: row.active_minutes,
    focusMinutes: row.focus_minutes,
    meetingMinutes: row.meeting_minutes,
    categoryBreakdown: row.category_breakdown,
    focusBlockCount: row.focus_block_count,
    focusBlockMinutes: row.focus_block_minutes,
    hourlyFocusMinutes: row.hourly_focus_minutes,
    tasksCompleted: row.tasks_completed,
    agentVersion: row.agent_version,
  };
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured.' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const admin = getSupabaseAdmin();

  // A cron has no client, so this is the ONE place we read the server clock for a
  // civil date — and only as a freshness CUTOFF (the 2-day window absorbs
  // timezone skew). The insight's actual date is each user's own local-dated
  // summary (below), never this UTC date.
  const referenceDate = new Date().toISOString().slice(0, 10);

  // Paid gate, query-level half.
  const { data: paidRows, error: paidErr } = await admin.from('users').select('id').eq('is_paid', true);
  if (paidErr) {
    return NextResponse.json({ error: 'Could not load paid users.' }, { status: 500 });
  }
  const paidIds = (paidRows ?? []).map((r) => r.id as string);
  if (paidIds.length === 0) {
    return NextResponse.json({ submitted: 0, reason: 'no paid users' });
  }

  // Most-recent summary per paid user, within the freshness window (no upper
  // bound: a timezone-ahead user's local date can exceed the UTC reference).
  const { data: recentRows, error: recentErr } = await admin
    .from('daily_summaries')
    .select('user_id, date')
    .in('user_id', paidIds)
    .gte('date', rosterCutoff(referenceDate, ROSTER_FRESHNESS_DAYS));
  if (recentErr) {
    return NextResponse.json({ error: 'Could not load recent summaries.' }, { status: 500 });
  }

  const latestByUser = new Map<string, string>();
  for (const row of recentRows ?? []) {
    const uid = row.user_id as string;
    const d = row.date as string;
    const cur = latestByUser.get(uid);
    if (!cur || d > cur) latestByUser.set(uid, d);
  }

  const candidates: RosterCandidate[] = paidIds.map((id) => ({
    userId: id,
    isPaid: true,
    latestSummaryDate: latestByUser.get(id) ?? null,
  }));
  const roster = selectRoster(candidates, referenceDate, ROSTER_FRESHNESS_DAYS);
  if (roster.length === 0) {
    return NextResponse.json({ submitted: 0, reason: 'no fresh paid users' });
  }

  // Build one batch request per user. custom_id encodes "<userId>__<date>" so the
  // collect cron re-derives both from the results (underscores aren't in UUIDs or
  // dates, so the separator is unambiguous; ':' is disallowed in custom_id).
  const requests: { custom_id: string; params: Anthropic.MessageCreateParamsNonStreaming }[] = [];
  for (const entry of roster) {
    const { data: winRows, error: winErr } = await admin
      .from('daily_summaries')
      .select('*')
      .eq('user_id', entry.userId)
      .gte('date', fetchWindowStart(entry.insightDate))
      .lte('date', entry.insightDate)
      .order('date', { ascending: true });
    if (winErr) {
      return NextResponse.json({ error: 'Could not load a user window.' }, { status: 500 });
    }

    const summaries = ((winRows ?? []) as DailySummaryRow[]).map(rowToSummary);
    const { schedule } = await getWorkSchedule(admin, entry.userId);
    const ctx = buildDayInsightContext(summaries, schedule, entry.insightDate);
    // insightDate came from a real summary, so ctx.summary is present; guard anyway.
    if (!ctx.summary) continue;

    const userMessage = buildInsightsUserMessage(ctx.summary, {
      peakHours: ctx.peakHours,
      streak: ctx.streak,
      thisWeekAvg: ctx.thisWeekAvg,
      lastWeekAvg: ctx.lastWeekAvg,
    });

    requests.push({
      custom_id: buildCustomId(entry.userId, entry.insightDate),
      params: {
        model: INSIGHTS_MODEL,
        max_tokens: INSIGHTS_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      },
    });
  }

  if (requests.length === 0) {
    return NextResponse.json({ submitted: 0, reason: 'no payloads built' });
  }

  try {
    const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
    const batch = await anthropic.messages.batches.create({ requests });

    const { error: insErr } = await admin.from('insight_batches').insert({
      batch_id: batch.id,
      model: INSIGHTS_MODEL,
      status: 'submitted',
      request_count: requests.length,
    });
    if (insErr) {
      // The batch IS submitted; the tracking insert failed. Surface loudly — the
      // collect cron keys off this row, so without it the batch is orphaned.
      return NextResponse.json(
        { error: 'Batch submitted but tracking insert failed.', batchId: batch.id },
        { status: 500 },
      );
    }

    return NextResponse.json({ submitted: requests.length, batchId: batch.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? `Batch submit failed: ${err.message}` : 'Batch submit failed.' },
      { status: 502 },
    );
  }
}
