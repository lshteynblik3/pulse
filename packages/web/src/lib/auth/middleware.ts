import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route prefixes that require a signed-in user. A path matches if it equals the
 * prefix exactly or is a subroute of it (so '/settings' also guards
 * '/settings/anything'). Everything else is public — including '/', '/signin',
 * '/auth/callback', and '/api/ingest' (the agent posts there with no session
 * cookie; 4b replaces that with per-device token auth).
 */
const PROTECTED_PREFIXES = ['/dashboard', '/settings'];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Runs on every (non-static) request. Two jobs:
 *   1. Refresh the Supabase session cookie so it never goes stale — this is the
 *      step @supabase/ssr requires in middleware for SSR auth to work at all.
 *   2. Redirect unauthenticated requests for protected routes to /signin.
 *
 * The getAll/setAll dance keeps the request and response cookie jars in sync so
 * the rotated session is written back to the browser.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() revalidates the token against Supabase — do not trust getSession()
  // here, which only reads the (possibly forged) cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && isProtected(request.nextUrl.pathname)) {
    const signInUrl = request.nextUrl.clone();
    signInUrl.pathname = '/signin';
    return NextResponse.redirect(signInUrl);
  }

  return response;
}
