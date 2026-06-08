import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { ActivityEvent } from '@pulse/shared';
import { getSupabaseAdmin } from '@/lib/supabase';

// zod schema mirroring the ActivityEvent contract from @pulse/shared. The
// `satisfies` check below makes the compiler fail if this schema ever drifts
// from the shared type.
const activityEventSchema = z.object({
  appName: z.string().min(1),
  category: z.enum([
    'development',
    'communication',
    'creative',
    'admin',
    'browser',
    'other',
  ]),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  idle: z.boolean(),
});

const payloadSchema = z.array(activityEventSchema).min(1);

// Compile-time guarantee that the schema produces exactly an ActivityEvent[].
type _SchemaMatchesContract = z.infer<typeof activityEventSchema> extends ActivityEvent
  ? ActivityEvent extends z.infer<typeof activityEventSchema>
    ? true
    : never
  : never;
const _check: _SchemaMatchesContract = true;
void _check;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON.' }, { status: 400 });
  }

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid ActivityEvent[].', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const events: ActivityEvent[] = parsed.data;

  // raw_events only stores app name + interval. Category/idle are validated but
  // not persisted in this phase.
  const rows = events.map((e) => ({
    app_name: e.appName,
    started_at: e.startedAt,
    ended_at: e.endedAt,
  }));

  const { error } = await getSupabaseAdmin().from('raw_events').insert(rows);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ inserted: rows.length }, { status: 201 });
}
