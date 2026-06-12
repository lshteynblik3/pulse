import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient } from '@/lib/auth/server';

/**
 * GET/PUT /api/account — the signed-in user's profile basics (Phase 4g).
 *
 * Auth-INDEPENDENT by design: this reads/writes the existing users row keyed by
 * auth.uid(), identically no matter what auth flow produced the session — the
 * future email+password/OAuth phase only has to pre-fill display_name better.
 *
 * Session client throughout, same defense-in-depth as work-schedule: the
 * explicit id filter is the app-level half; RLS (select-own policy, plus
 * migration 0008's update-own policy with a display_name-only column grant)
 * is the other. Email is the AUTH identity — read-only here; even a crafted
 * PUT body cannot write it (zod .strict() rejects unknown keys at the app
 * layer, and the column grant stops it at the DB layer).
 */

const putSchema = z
  .object({
    // null clears the name (UI then falls back to email everywhere).
    displayName: z.string().trim().min(1).max(80).nullable(),
  })
  .strict();

type AccountBody = { email: string; displayName: string | null };

export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('users')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'Could not load your account.' }, { status: 500 });
  }

  // Email comes from the session (the auth identity), not the users copy —
  // it's what the user actually signs in with.
  const body: AccountBody = {
    email: user.email ?? '',
    displayName: (data?.display_name as string | null) ?? null,
  };
  return NextResponse.json(body);
}

export async function PUT(request: Request) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON.' }, { status: 400 });
  }

  const parsed = putSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid account update.' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('users')
    .update({ display_name: parsed.data.displayName })
    .eq('id', user.id)
    .select('display_name');

  if (error) {
    return NextResponse.json({ error: 'Could not save your name.' }, { status: 500 });
  }
  if (!data || data.length === 0) {
    // The provisioning upsert in /auth/callback creates this row at first
    // sign-in; matching zero rows is a server-side inconsistency, not user error.
    return NextResponse.json({ error: 'Could not save your name.' }, { status: 500 });
  }

  const body: AccountBody = {
    email: user.email ?? '',
    displayName: (data[0]?.display_name as string | null) ?? null,
  };
  return NextResponse.json(body);
}
