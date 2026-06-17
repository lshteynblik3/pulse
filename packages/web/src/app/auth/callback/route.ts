import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/auth/server';
import { getSupabaseAdmin } from '@/lib/supabase';

/**
 * GET /auth/callback
 *
 * The magic link in the email points here with a `?code=...`. We exchange that
 * code for a session (which sets the session cookies), make sure the user has a
 * row in `users`, then send them to the dashboard.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  if (!code) {
    return NextResponse.redirect(`${origin}/signin?error=missing_code`);
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/signin?error=exchange_failed`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user?.email) {
    // First sign-in provisions the app's `users` row, keyed by auth.uid().
    // ignoreDuplicates → ON CONFLICT DO NOTHING, so a display_name the user later
    // edits is never overwritten on subsequent sign-ins. We use the service-role
    // admin client here so this write doesn't depend on the user's own RLS grants.
    await getSupabaseAdmin()
      .from('users')
      .upsert(
        {
          id: user.id,
          email: user.email,
          display_name: user.email.split('@')[0],
          role: 'member',
        },
        { onConflict: 'id', ignoreDuplicates: true },
      );
  }

  return NextResponse.redirect(`${origin}/dashboard`);
}
