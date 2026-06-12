import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { DailySummary } from '@pulse/shared';
import { getSupabaseAdmin } from '@/lib/supabase';
import { hashDeviceToken } from '@/lib/devices/pairing';

// zod schema mirroring the DailySummary contract from @pulse/shared. This is now
// the ONLY shape the server accepts — raw ActivityEvents never reach it
// (CLAUDE.md hard rule #2). The compile-time check below fails the build if this
// schema ever drifts from the shared type.
const categoryBreakdownSchema = z.object({
  development: z.number().nonnegative(),
  communication: z.number().nonnegative(),
  creative: z.number().nonnegative(),
  admin: z.number().nonnegative(),
  browser: z.number().nonnegative(),
  entertainment: z.number().nonnegative(),
  other: z.number().nonnegative(),
});

const dailySummarySchema = z.object({
  userId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  activeMinutes: z.number().nonnegative(),
  focusMinutes: z.number().nonnegative(),
  meetingMinutes: z.number().nonnegative(),
  categoryBreakdown: categoryBreakdownSchema,
  focusBlockCount: z.number().int().nonnegative(),
  focusBlockMinutes: z.number().nonnegative(),
  hourlyFocusMinutes: z.array(z.number().nonnegative()).length(24),
  tasksCompleted: z.number().int().nonnegative(),
  agentVersion: z.string().min(1),
});

// Compile-time guarantee that the schema produces exactly a DailySummary.
type _SchemaMatchesContract = z.infer<typeof dailySummarySchema> extends DailySummary
  ? DailySummary extends z.infer<typeof dailySummarySchema>
    ? true
    : never
  : never;
const _check: _SchemaMatchesContract = true;
void _check;

/**
 * Device-token auth (Phase 4b). The agent sends `Authorization: Bearer <token>`;
 * we look up sha256(token) in device_tokens. Service-role use #2 of 2 (see also
 * pair/consume): the lookup must bypass RLS because the agent has no Supabase
 * session — the token itself is the credential being verified.
 *
 * Returns the device row's user_id, or null for anything that isn't a valid,
 * unrevoked token. A revoked token fails from the next request onward — the
 * agent treats this exact 401 as "wipe local credentials and re-pair."
 */
async function authenticateDevice(
  request: Request,
): Promise<{ userId: string; deviceTokenId: string } | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) return null;

  const { data, error } = await getSupabaseAdmin()
    .from('device_tokens')
    .select('id, user_id')
    .eq('token_hash', hashDeviceToken(token))
    .is('revoked_at', null)
    .maybeSingle();

  if (error || !data) return null;
  return { userId: data.user_id as string, deviceTokenId: data.id as string };
}

export async function POST(request: Request) {
  const device = await authenticateDevice(request);
  if (!device) {
    return NextResponse.json({ error: 'Invalid or missing device token.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON.' }, { status: 400 });
  }

  const parsed = dailySummarySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid DailySummary.', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const s: DailySummary = parsed.data;

  // Full upsert of the day's summary, keyed by (user_id, date). Re-sends every
  // ~15 min overwrite this row with the latest cumulative totals — never deltas.
  //
  // user_id comes from the BEARER TOKEN, never the body — whatever the agent put
  // in summary.userId (historically its device UUID) is discarded here. And the
  // body's date is accepted as-is, deliberately: the agent's recovery-flush path
  // legitimately sends prior days, so there must be no "is it today" check — the
  // agent is the source of truth for which local day its data belongs to.
  const row = {
    user_id: device.userId,
    date: s.date,
    active_minutes: s.activeMinutes,
    focus_minutes: s.focusMinutes,
    meeting_minutes: s.meetingMinutes,
    category_breakdown: s.categoryBreakdown,
    focus_block_count: s.focusBlockCount,
    focus_block_minutes: s.focusBlockMinutes,
    hourly_focus_minutes: s.hourlyFocusMinutes,
    tasks_completed: s.tasksCompleted,
    agent_version: s.agentVersion,
    updated_at: new Date().toISOString(),
  };

  const { error } = await getSupabaseAdmin()
    .from('daily_summaries')
    .upsert(row, { onConflict: 'user_id,date' });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Bump last_used_at only after a successful authenticated write, so the
  // /settings/devices "last used" column reflects real ingests, not attempts.
  // Best-effort: a failure here must not fail the flush the agent already made.
  await getSupabaseAdmin()
    .from('device_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', device.deviceTokenId);

  return NextResponse.json({ ok: true, date: s.date }, { status: 200 });
}
