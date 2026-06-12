import { Fraunces } from 'next/font/google';
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
  await requireUser();

  return (
    <main className={`${fraunces.variable} ${styles.page}`}>
      <DashboardClient />
    </main>
  );
}
