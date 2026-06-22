'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamAggregateResult } from '@/lib/teams/aggregate';
import { displayScore, formatMinutes, localDateString } from '@/lib/dashboard/format';
import styles from './team.module.css';

/**
 * The manager's team view body. Like the dashboard client, "today" originates
 * HERE from the browser's local clock (never the server's, never toISOString) and
 * is sent to the endpoint as ?date=. The endpoint re-authorizes the teamId; this
 * component only renders what it returns.
 *
 * Two ready states off the discriminant: `populated` (the stat cards) and
 * `suppressed` (the rule, nothing numeric). A 403 shouldn't happen — the page
 * only mounts this for the manager's own team — but is handled as a plain error.
 */
type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; result: TeamAggregateResult };

export default function TeamClient({ teamId }: { teamId: string }) {
  const [today] = useState(() => localDateString(new Date()));
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setState({ status: 'loading' });
    fetch(`/api/teams/${teamId}/aggregate?date=${today}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`team aggregate responded ${res.status}`);
        return (await res.json()) as TeamAggregateResult;
      })
      .then((result) => setState({ status: 'ready', result }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ status: 'error' });
      });
  }, [teamId, today]);

  useEffect(() => {
    load();
    return () => inFlight.current?.abort();
  }, [load]);

  if (state.status === 'loading') {
    return <p className={styles.muted}>Loading your team…</p>;
  }

  if (state.status === 'error') {
    return (
      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>Couldn&apos;t load your team</h2>
        <p className={styles.muted}>
          Something went wrong on our side — give it another try.
        </p>
        <button className={styles.retry} onClick={load}>
          Try again
        </button>
      </section>
    );
  }

  return state.result.state === 'populated' ? (
    <Populated result={state.result} />
  ) : (
    <Suppressed />
  );
}

function Populated({ result }: { result: Extract<TeamAggregateResult, { state: 'populated' }> }) {
  return (
    <>
      <div className={styles.statGrid}>
        <Stat
          label="Avg focus score"
          value={result.avgFocusScore !== null ? String(displayScore(result.avgFocusScore)) : '—'}
        />
        <Stat
          label="Avg meeting load"
          value={result.avgMeetingMinutes !== null ? formatMinutes(result.avgMeetingMinutes) : '—'}
          detail="per tracked day"
        />
        <Stat
          label="Active streaks"
          value={String(result.activeStreakCount)}
          detail={`of ${result.reportingMembers} reporting`}
        />
      </div>
      {/* The honesty line — what the averages are actually over. */}
      <p className={styles.reportingLine}>
        Averages across {result.reportingMembers} reporting member
        {result.reportingMembers === 1 ? '' : 's'} this week.
      </p>
    </>
  );
}

/**
 * Suppressed: state the RULE, show nothing numeric. We deliberately do NOT render
 * a count or "X of Y" — the live reporting count is a soft re-identification leak
 * on a small team, so the message names only the fixed threshold.
 */
function Suppressed() {
  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>Not enough reporting members yet</h2>
      <p className={styles.muted}>
        Team averages need at least 3 reporting members to display, so no one&apos;s
        individual patterns can be singled out from the group. Once enough of the
        team is tracking, the team view fills in here.
      </p>
    </section>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className={styles.stat}>
      <p className={styles.statLabel}>{label}</p>
      <p className={styles.statValue}>{value}</p>
      {detail && <p className={styles.statDetail}>{detail}</p>}
    </div>
  );
}
