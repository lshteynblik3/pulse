import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/auth/server';
import { getWorkSchedule } from '@/lib/work-schedule/loader';
import { scheduleToRow, workScheduleSchema } from '@/lib/work-schedule/schema';

/**
 * GET /api/work-schedule — the signed-in user's schedule, stored or default.
 *
 * Session client only (4b pattern): RLS scopes the read to auth.uid(), and the
 * loader's user_id filter is the app-level half of the same check. `isDefault`
 * tells the settings UI to show "these are defaults — you haven't set a
 * schedule yet."
 */
export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  try {
    const { schedule, isDefault } = await getWorkSchedule(supabase, user.id);
    return NextResponse.json({ schedule, isDefault });
  } catch {
    return NextResponse.json({ error: 'Could not load your work schedule.' }, { status: 500 });
  }
}

/**
 * PUT /api/work-schedule — full-object replace of the user's schedule.
 *
 * Deliberately not a PATCH: the form loads the whole schedule and saves the
 * whole schedule, so partial-update merge bugs can't exist. The row is created
 * on first save (upsert on the user_id primary key) — no signup trigger, no row
 * means "defaults". user_id comes from the session, never the body.
 */
export async function PUT(request: Request) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON.' }, { status: 400 });
  }

  const parsed = workScheduleSchema.safeParse(body);
  if (!parsed.success) {
    // The first issue's message is written for humans ("Select at least one
    // working day.") — the settings UI surfaces it directly.
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? 'Invalid work schedule.',
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from('work_schedules')
    .upsert({ ...scheduleToRow(user.id, parsed.data), updated_at: new Date().toISOString() });

  if (error) {
    return NextResponse.json({ error: 'Could not save your work schedule.' }, { status: 500 });
  }

  // Echo the normalized (deduped/sorted) schedule so the form can re-render
  // exactly what was stored.
  return NextResponse.json({ schedule: parsed.data, isDefault: false });
}
