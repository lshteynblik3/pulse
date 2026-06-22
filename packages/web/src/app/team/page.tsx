import { Fraunces } from 'next/font/google';
import Link from 'next/link';
import { createServerClient, requireUser } from '@/lib/auth/server';
import TeamClient from './team-client';
import styles from './team.module.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['500', '600'],
  variable: '--font-display',
  display: 'swap',
});

/**
 * /team — the manager's team view (Phase 6 commit 2).
 *
 * Server shell, same split as /dashboard: the page resolves WHO is asking and
 * WHICH team server-side, but the data fetch lives in the client component
 * because the aggregate's `date` must come from the manager's BROWSER local clock
 * (the server never derives "today").
 *
 * The team is the SESSION user's own team_id, read here under the session client
 * (RLS read-own on the users row). The route still re-authorizes via
 * canManageTeam — the page just picks which teamId to ask about; it is not the
 * authority. A non-manager, or a manager with no team, sees a calm empty state and
 * never reaches the endpoint.
 *
 * SCOPE: single-team manager only. An admin who spans multiple teams needs a team
 * picker — deferred to a later commit; noted in the empty state.
 */
export default async function TeamPage() {
  const user = await requireUser();
  const supabase = await createServerClient();

  // Read-own users row (RLS) — role + team decide what this page can show.
  const { data: profile } = await supabase
    .from('users')
    .select('role, team_id')
    .eq('id', user.id)
    .maybeSingle();

  const role = (profile?.role as string | undefined) ?? 'member';
  const teamId = (profile?.team_id as string | null | undefined) ?? null;
  const isManager = role === 'manager' || role === 'admin';

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
          <p className={styles.kicker}>Team</p>
          <h1 className={styles.heading}>Your team</h1>
          <p className={styles.subhead}>Team-level patterns — aggregates only, never individual activity.</p>
        </header>

        {isManager && teamId ? (
          <TeamClient teamId={teamId} />
        ) : (
          <section className={styles.card}>
            <h2 className={styles.sectionTitle}>No team view</h2>
            <p className={styles.muted}>
              {role === 'admin'
                ? 'Your account spans the whole org. Per-team views with a team picker are coming soon.'
                : "You don't manage a team, so there's no team view here. If that's unexpected, your admin can set up your team."}
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
