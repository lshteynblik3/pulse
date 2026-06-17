import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/auth/middleware';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Run on everything except Next's static assets and the favicon. The session
  // refresh needs to happen broadly; the actual route protection (which paths
  // require auth) is decided inside updateSession.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
