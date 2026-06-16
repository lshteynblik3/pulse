import { Fraunces } from 'next/font/google';
import Link from 'next/link';
import { requireUser } from '@/lib/auth/server';
import { signOut } from '@/lib/auth/actions';
import DashboardClient from './dashboard-client';
import styles from './dashboard.module.css';

// The display face for the big numerals and date heading; exposed as a CSS
// variable so the module stylesheet owns where it's applied. Body text stays
// the system stack the rest of the app uses.
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['500', '600'],
  variable: '--font-display',
  display: 'swap',
});

/**
 * /dashboard — the employee view (Phase 4e), replacing the Phase-1 slice page.
 *
 * Server component shell, same pattern as /settings/*: requireUser() (plus the
 * middleware on /dashboard) gates the page. Everything else lives in the
 * client component — deliberately, because "today" must come from the
 * BROWSER's local clock, so the data fetch cannot happen in a server render.
 */
export default async function DashboardPage() {
  // The signed-in identity comes from the session requireUser() already
  // resolves — shown in the top bar so "which account am I looking at?" is
  // always answerable at a glance (the agent's tray shows its own half).
  // requireUser() redirects unauthenticated visitors to /signin, so `user` is
  // present here; the login-link branch below is defensive only.
  const user = await requireUser();

  return (
    <main className={`${fraunces.variable} ${styles.page}`}>
      <nav className={styles.topBar} aria-label="Account">
        {user.email ? (
          <>
            <span className={styles.identity}>{user.email}</span>
            <span className={styles.topLinks}>
              {/* Two vestigial nav buttons collapsed into one — /settings already
                  consolidates account/devices/work-schedule as anchored sections. */}
              <Link href="/settings">Settings</Link>
              {/* Sign out via the existing server action → clears the session and
                  redirects to /signin (the login page, reworked in a later phase). */}
              <form action={signOut} className={styles.logoutForm}>
                <button type="submit" className={styles.logout}>
                  Log out
                </button>
              </form>
            </span>
          </>
        ) : (
          <span className={styles.topLinks}>
            <Link href="/signin">Log in</Link>
          </span>
        )}
      </nav>
      <DashboardClient />
    </main>
  );
}
