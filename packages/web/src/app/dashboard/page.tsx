import { Fraunces } from 'next/font/google';
import Link from 'next/link';
import { requireUser } from '@/lib/auth/server';
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
  const user = await requireUser();

  return (
    <main className={`${fraunces.variable} ${styles.page}`}>
      <nav className={styles.topBar} aria-label="Account and settings">
        <span className={styles.identity}>{user.email}</span>
        <span className={styles.topLinks}>
          <Link href="/settings/devices">Devices</Link>
          <Link href="/settings/work-schedule">Work schedule</Link>
        </span>
      </nav>
      <DashboardClient />
    </main>
  );
}
