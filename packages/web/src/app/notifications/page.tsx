import { Fraunces } from 'next/font/google';
import Link from 'next/link';
import { createServerClient, requireUser } from '@/lib/auth/server';
import { relativeTimeLabel } from '@/lib/dashboard/format';
import styles from './notifications.module.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['500', '600'],
  variable: '--font-display',
  display: 'swap',
});

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  created_at: string;
}

/**
 * /notifications — the employee's "you've been told" surface (Phase 6 recognition).
 *
 * Server component: a plain session-client read under RLS read-own (0013), so no
 * browser-local-date is needed (notifications are rows, not a date window). This is
 * where the standing promise is made literally true and visible to the person it
 * protects: anything a manager is shown about them, or (later) any drill-in to their
 * detail, shows up here.
 */
export default async function NotificationsPage() {
  const user = await requireUser();
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('notifications')
    .select('id, type, title, body, created_at')
    .eq('recipient_id', user.id)
    .order('created_at', { ascending: false });

  const notifications = (data ?? []) as NotificationRow[];

  return (
    <main className={`${fraunces.variable} ${styles.page}`}>
      <nav className={styles.topBar} aria-label="Account">
        <span className={styles.identity}>{user.email}</span>
        <span className={styles.topLinks}>
          <Link href="/dashboard">My dashboard</Link>
          <Link href="/settings">Settings</Link>
        </span>
      </nav>

      <div className={styles.shell}>
        <header>
          <p className={styles.kicker}>Notifications</p>
          <h1 className={styles.heading}>What&apos;s been shared</h1>
          {/* The standing promise — literally true: recognition notifies now, and
              the later drill-in will notify too. Both directions tell you. */}
          <p className={styles.promise}>
            We&apos;ll never share specifics or constructive detail about you without telling
            you first. When your manager is shown one of your highlights, or views your
            detailed activity, you&apos;ll see it here.
          </p>
        </header>

        {error ? (
          <section className={styles.card}>
            <h2 className={styles.sectionTitle}>Couldn&apos;t load your notifications</h2>
            <p className={styles.muted}>Something went wrong on our side — give it another try.</p>
          </section>
        ) : notifications.length === 0 ? (
          <section className={styles.card}>
            <h2 className={styles.sectionTitle}>Nothing yet</h2>
            <p className={styles.muted}>
              When there&apos;s something to tell you — like your manager being shown a
              highlight of your week — it&apos;ll appear here.
            </p>
          </section>
        ) : (
          <ul className={styles.list}>
            {notifications.map((n) => (
              <li key={n.id} className={styles.item}>
                <h2 className={styles.itemTitle}>{n.title}</h2>
                <p className={styles.itemBody}>{n.body}</p>
                <p className={styles.itemTime}>{relativeTimeLabel(n.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
