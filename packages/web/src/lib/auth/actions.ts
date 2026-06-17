'use server';

import { redirect } from 'next/navigation';
import { createServerClient } from './server';

/**
 * Sign-out server action. Clears the session cookies and bounces to /signin.
 * Used as the `action` of the sign-out form in the authed header.
 */
export async function signOut() {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  redirect('/signin');
}
