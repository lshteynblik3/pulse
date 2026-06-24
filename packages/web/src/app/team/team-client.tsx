'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamAggregateResult } from '@/lib/teams/aggregate';
import type { MemberDetailPayload } from '@/lib/teams/member-detail';
import { displayScore, formatMinutes, localDateString, percentLabel } from '@/lib/dashboard/format';
import styles from './team.module.css';

/**
 * The manager's team view body. Like the dashboard client, "today" originates
 * HERE from the browser's local clock (never the server's, never toISOString) and
 * is sent to the endpoints as ?date=. The endpoints re-authorize the teamId; this
 * component only renders what they return.
 *
 * Renders TWO independent sections: Recognition (sparse positive cards) and the
 * Aggregate (team averages). They load separately so one failing never blanks the
 * other.
 */
export default function TeamClient({ teamId }: { teamId: string }) {
  const [today] = useState(() => localDateString(new Date()));
  return (
    <>
      <RecognitionSection teamId={teamId} date={today} />
      <AggregateSection teamId={teamId} date={today} />
    </>
  );
}

/**
 * Recognition cards. The GET is a pure read (prefetch-safe). After cards RENDER,
 * an effect POSTs their event_keys to /ack — that write is what notifies the named
 * employees, so the notification happens exactly because the manager saw the card
 * (the saw ⟹ told half of the biconditional). The ack is best-effort/idempotent: a
 * dropped POST just means no notify for this view, never a duplicate.
 */
interface RecognitionCard {
  eventKey: string;
  recipientId: string;
  type: string;
  name: string;
  eventDate: string;
  title: string;
  body: string;
}

function RecognitionSection({ teamId, date }: { teamId: string; date: string }) {
  // null = still loading; an array (possibly empty) = loaded. Errors resolve to []
  // because recognition is additive — a blip shows the calm empty state, not a crash.
  const [cards, setCards] = useState<RecognitionCard[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/teams/${teamId}/recognition?date=${date}`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ cards: RecognitionCard[] }>) : Promise.reject()))
      .then((data) => setCards(data.cards))
      .catch(() => setCards((prev) => prev ?? []));
    return () => controller.abort();
  }, [teamId, date]);

  useEffect(() => {
    if (!cards || cards.length === 0) return;
    fetch(`/api/teams/${teamId}/recognition/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, eventKeys: cards.map((c) => c.eventKey) }),
      keepalive: true, // survive a quick navigation away
    }).catch(() => {});
  }, [cards, teamId, date]);

  if (cards === null) return null; // quiet while loading

  if (cards.length === 0) {
    // The NORM. Phrased so it never reads as "everyone's underperforming".
    return (
      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>Recognition</h2>
        <p className={styles.muted}>No new highlights to recognize this week.</p>
      </section>
    );
  }

  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>Recognition</h2>
      <p className={styles.muted}>
        Highlights worth acknowledging. Each team member is told when you&apos;re shown theirs.
      </p>
      <ul className={styles.recognitionList}>
        {cards.map((c) => (
          <RecognitionCardRow key={c.eventKey} card={c} date={date} />
        ))}
      </ul>
    </section>
  );
}

/**
 * One recognition card + the ONLY drill-in entry point (Option A). "View activity"
 * is a deliberate click that POSTs /api/members/[id]/view — which logs the access
 * and notifies the member. There is no per-member roster anywhere; a manager can
 * only drill into a member who currently has a positive recognition event.
 */
function RecognitionCardRow({ card, date }: { card: RecognitionCard; date: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={styles.recognitionItem}>
      <h3 className={styles.recognitionTitle}>{card.title}</h3>
      <p className={styles.recognitionBody}>{card.body}</p>
      <button
        type="button"
        className={styles.viewActivity}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? 'Hide activity' : `View ${card.name}'s activity →`}
      </button>
      {/* Mounted ONLY after the explicit click — the POST (and its log+notify)
          never fires on render/prefetch. */}
      {open && <MemberDetail memberId={card.recipientId} name={card.name} date={date} />}
    </li>
  );
}

type DetailState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; detail: MemberDetailPayload };

function MemberDetail({ memberId, name, date }: { memberId: string; name: string; date: string }) {
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    // The deliberate view: a POST (never a GET), so this can't be prefetched.
    fetch(`/api/members/${memberId}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }),
      signal: controller.signal,
    })
      .then((res) => (res.ok ? (res.json() as Promise<MemberDetailPayload>) : Promise.reject()))
      .then((detail) => setState({ status: 'ready', detail }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [memberId, date]);

  if (state.status === 'loading') return <p className={styles.detailMuted}>Opening {name}&apos;s activity…</p>;
  if (state.status === 'error')
    return <p className={styles.detailMuted}>Couldn&apos;t open this member right now.</p>;

  const d = state.detail;
  return (
    <div className={styles.detailPanel}>
      <p className={styles.detailNotice}>{name} has been notified that you viewed this.</p>

      {!d.isWorkingDay ? (
        <p className={styles.detailMuted}>Not a working day — no score, and that&apos;s fine.</p>
      ) : !d.hasData ? (
        <p className={styles.detailMuted}>No data for this day yet.</p>
      ) : (
        <>
          <div className={styles.detailScoreRow}>
            <span className={styles.detailScore}>{d.displayScore}</span>
            <span className={styles.gaugeOutOf}>focus score</span>
          </div>
          {d.breakdown && (
            <ul className={styles.detailBreakdown}>
              {(
                [
                  ['Focus ratio', d.breakdown.focusRatio],
                  ['Deep-work blocks', d.breakdown.blockScore],
                  ['Meeting balance', d.breakdown.meetingBalance],
                  ['Consistency', d.breakdown.consistency],
                ] as [string, number][]
              ).map(([label, value]) => (
                <li key={label}>
                  <span>{label}</span>
                  <div className={styles.detailMeter}>
                    <div className={styles.detailMeterFill} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
                  </div>
                  <span className={styles.detailPct}>{percentLabel(Math.max(0, Math.min(1, value)))}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {d.focus && (
        <div className={styles.detailFocusStats}>
          <span>{formatMinutes(d.focus.focusMinutes)} focused</span>
          <span>
            {d.focus.focusBlockCount} block{d.focus.focusBlockCount === 1 ? '' : 's'} ·{' '}
            {formatMinutes(d.focus.focusBlockMinutes)}
          </span>
        </div>
      )}

      {d.strengths.length > 0 && (
        <div className={styles.detailStrengths}>
          <p className={styles.detailStrengthsLabel}>What&apos;s working</p>
          <ul>
            {d.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Two ready states off the discriminant: `populated` (the stat cards) and
 * `suppressed` (the rule, nothing numeric). A 403 shouldn't happen — the page
 * only mounts this for the manager's own team — but is handled as a plain error.
 */
type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; result: TeamAggregateResult };

function AggregateSection({ teamId, date: today }: { teamId: string; date: string }) {
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
