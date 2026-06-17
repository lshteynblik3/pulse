import { Fraunces } from 'next/font/google';
import Link from 'next/link';
import { requireUser } from '@/lib/auth/server';
import AccountClient from './account-client';
import DevicesClient from './devices-client';
import WorkScheduleClient from './work-schedule-client';
import styles from './settings.module.css';

// Same display face the dashboard loads — one typographic voice across the app.
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['500', '600'],
  variable: '--font-display',
  display: 'swap',
});

/**
 * /settings — account, devices, and work schedule on ONE page (Phase 4g),
 * replacing /settings/devices and /settings/work-schedule (which now redirect
 * to this page's anchors).
 *
 * Anchored sections over tabs: the old routes map cleanly onto fragments, there
 * is no client tab state to manage, and three short sections read naturally as
 * one calm page. Server-component shell, same protected pattern as before:
 * requireUser() (plus the /settings middleware) gates the page; each section's
 * logic lives unchanged in its client island.
 */
export default async function SettingsPage() {
  await requireUser();

  return (
    <main className={`${fraunces.variable} ${styles.page}`}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.kicker}>Settings</p>
            <h1 className={styles.heading}>Your Pulse setup</h1>
          </div>
          <Link className={styles.backLink} href="/dashboard">
            ← Back to dashboard
          </Link>
        </header>

        <nav className={styles.sectionNav} aria-label="Settings sections">
          <a href="#account">Account</a>
          <a href="#devices">Devices</a>
          <a href="#work-schedule">Work schedule</a>
        </nav>

        <section id="account" className={styles.card}>
          <h2 className={styles.sectionTitle}>Account</h2>
          <p className={styles.muted}>
            Who this data belongs to. Your email is how you sign in; your name is how
            Pulse refers to you.
          </p>
          <AccountClient />
        </section>

        <section id="devices" className={styles.card}>
          <h2 className={styles.sectionTitle}>Devices</h2>
          <p className={styles.muted}>
            Each device runs the Pulse agent and sends only your aggregated daily summary,
            tied to your account by a token that never leaves that machine unencrypted.
          </p>
          <DevicesClient />
        </section>

        <section id="work-schedule" className={styles.card}>
          <h2 className={styles.sectionTitle}>Work schedule</h2>
          <p className={styles.muted}>
            Tell Pulse when you actually work. Scoring judges consistency and streaks against
            these days — vacation days are never counted against you.
          </p>
          <WorkScheduleClient />
        </section>
      </div>
    </main>
  );
}
