import { createServerClient as createSSRClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

/**
 * The cookie-bound Supabase client for server components and route handlers.
 *
 * This uses the PUBLIC anon key, not the service-role key — so every query it
 * runs is subject to Row Level Security and only sees the signed-in user's rows.
 * The session lives in httpOnly cookies managed by @supabase/ssr; the middleware
 * refreshes them on each request.
 *
 * Next 15's `cookies()` is async, so this helper is async too. Always create the
 * client through here — never call @supabase/ssr directly elsewhere — so the
 * cookie wiring stays in exactly one place.
 */
export async function createServerClient() {
  const cookieStore = await cookies();

  return createSSRClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          // In a plain server component, setting cookies during render throws —
          // that's fine, the middleware owns session refresh. In route handlers
          // and server actions this succeeds and persists the rotated session.
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // No-op: called from a server component render. Middleware handles it.
          }
        },
      },
    },
  );
}

/**
 * Returns the authenticated user, or redirects to /signin if there is none.
 *
 * Use this at the top of any protected server component or route handler that
 * needs the user. Middleware already gates the route, but calling this is the
 * belt-and-suspenders that also hands you the user object.
 */
export async function requireUser(): Promise<User> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/signin');
  }
  return user;
}
