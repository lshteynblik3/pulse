'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  DailySummary,
  FocusScoreResult,
  PeakHour,
  ScoreBreakdown,
  Streak,
  Trend,
} from '@pulse/shared';
// Type-only import of the API's own payload type — the page conforms to the
// shape compute.ts defines, never a parallel one. Erased at compile time.
import type { DashboardPayload } from '@/lib/dashboard/compute';
import {
  formatDateHeading,
  formatMinutes,
  hourRangeLabel,
  hourTickLabel,
  localDateString,
  percentLabel,
  relativeTimeLabel,
  scoreColor,
  scoreMessage,
  streakMessage,
} from '@/lib/dashboard/format';
import { buildStatCards } from '@/lib/dashboard/stat-cards';
import { SHOW_TASKS } from '@/lib/flags';
import styles from './dashboard.module.css';

/**
 * Autorefresh cadence. The score only moves on the agent's 15-min flush or
 * another device posting, so 5 min keeps the page honest without wasted
 * fetches (same rationale as the agent widget). Paused while the tab is hidden.
 */
const REFRESH_MS = 5 * 60 * 1000;
/** How often the "Updated X ago" label re-renders so it stays honest. */
const FRESHNESS_TICK_MS = 30 * 1000;

/**
 * Three states, kept distinct all the way to the UI: loading, error (retryable
 * — never rendered as a blank or fake-zero dashboard), and ready. Ready with
 * today.summary === null is the legitimate "no data yet today" case, NOT an
 * error.
 */
type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; payload: DashboardPayload };

export default function DashboardClient() {
  // The date the page is SHOWING. "Today" originates HERE, from the browser's
  // local clock components — never toISOString() (UTC) and never the server's
  // clock. Held in state so date navigation (Batch C) can drive it; every
  // refresh re-fetches THIS date, so a refresh never silently jumps the view to
  // today. (A manual reload recomputes today at mount; the autorefresh doesn't.)
  const [viewedDate] = useState(() => localDateString(new Date()));
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  // ISO instant of the last successful fetch — drives the "Updated X ago" line.
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  // A ticking counter so the relative "Updated X ago" label stays honest
  // between fetches, without re-fetching.
  const [, setFreshnessTick] = useState(0);
  const inFlight = useRef<AbortController | null>(null);

  // Fetch the dashboard for `date`. A BACKGROUND refresh (interval / refocus)
  // shows no loading state and, on failure, keeps the last good data on screen
  // (the freshness just goes stale) — like the agent pill, a transient blip
  // never blanks a working dashboard. Only a foreground load surfaces the error.
  const load = useCallback((date: string, opts?: { background?: boolean }) => {
    const background = opts?.background ?? false;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    if (!background) setState({ status: 'loading' });
    fetch(`/api/dashboard?date=${date}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`dashboard responded ${res.status}`);
        return (await res.json()) as DashboardPayload;
      })
      .then((payload) => {
        setState({ status: 'ready', payload });
        setLastUpdatedAt(new Date().toISOString());
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!background) setState({ status: 'error' });
      });
  }, []);

  // Initial load + autorefresh. The 5-min interval runs only while the tab is
  // visible; hiding pauses it, refocusing fires one immediate refresh and
  // restarts it — mirrors the agent widget's visible-only timer.
  useEffect(() => {
    load(viewedDate);

    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval === null) {
        interval = setInterval(() => load(viewedDate, { background: true }), REFRESH_MS);
      }
    };
    const stop = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        load(viewedDate, { background: true });
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      inFlight.current?.abort();
    };
  }, [load, viewedDate]);

  // Keep "Updated X ago" honest between fetches.
  useEffect(() => {
    const t = setInterval(() => setFreshnessTick((n) => n + 1), FRESHNESS_TICK_MS);
    return () => clearInterval(t);
  }, []);

  if (state.status === 'loading') {
    return (
      <div className={styles.shell}>
        <p className={styles.muted}>Loading your day…</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className={styles.shell}>
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>Couldn&apos;t load your dashboard</h2>
          <p className={styles.muted}>
            Something went wrong on our side — your data is safe. Give it another try.
          </p>
          <p style={{ marginTop: 14 }}>
            <button className={styles.retry} onClick={() => load(viewedDate)}>
              Try again
            </button>
          </p>
        </section>
      </div>
    );
  }

  const { payload } = state;
  const { summary, focus } = payload.today;

  return (
    <div className={styles.shell}>
      <header>
        <p className={styles.kicker}>Your day</p>
        <h1 className={styles.dateHeading}>{formatDateHeading(payload.date)}</h1>
        <p className={styles.lastActivity}>
          {payload.agent.lastActivityAt
            ? `Agent last posted ${relativeTimeLabel(payload.agent.lastActivityAt)}`
            : 'No agent has posted yet'}
        </p>
        {lastUpdatedAt && (
          <p className={styles.freshness}>Updated {relativeTimeLabel(lastUpdatedAt)}</p>
        )}
      </header>

      {payload.schedule.isDefault && <DefaultScheduleBanner />}

      {summary && focus ? <FocusHero focus={focus} /> : <EmptyHero />}

      {summary && <StatCards summary={summary} />}
      {summary && <HourlyChart hourly={summary.hourlyFocusMinutes} />}

      <PeakHours peakHours={payload.peakHours} />

      <div className={styles.duo}>
        <StreakCard streak={payload.streak} />
        <TrendCard trend={payload.trend} />
      </div>

      <InsightsPlaceholder />
    </div>
  );
}

function DefaultScheduleBanner() {
  return (
    <p className={styles.banner}>
      Scores currently assume a default Mon–Fri, 8-hour schedule.{' '}
      <Link href="/settings#work-schedule">Set your real schedule</Link> so days off never
      count against you.
    </p>
  );
}

/** No data today is a calm state, not an error — and not zeros pretending to be real. */
function EmptyHero() {
  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>No data from today yet</h2>
      <p className={styles.muted}>
        Once the Pulse agent has been running on this account&apos;s machine, today&apos;s
        focus score and hours show up here. If it&apos;s been a while, check{' '}
        <Link href="/settings#devices">Settings → Devices</Link>.
      </p>
    </section>
  );
}

function FocusHero({ focus }: { focus: FocusScoreResult }) {
  return (
    <section className={`${styles.card} ${styles.hero}`}>
      <div className={styles.gaugeWrap}>
        <Gauge score={focus.score} />
        <p className={styles.scoreMessage}>{scoreMessage(focus.score)}</p>
      </div>
      <BreakdownBars breakdown={focus.breakdown} />
    </section>
  );
}

const GAUGE_R = 84;
const GAUGE_C = 2 * Math.PI * GAUGE_R;
const GAUGE_ARC = GAUGE_C * 0.75; // a 270° sweep, opening at the bottom

function Gauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const filled = (clamped / 100) * GAUGE_ARC;
  const color = scoreColor(score);
  return (
    <div className={styles.gauge}>
      <svg viewBox="0 0 200 200" role="img" aria-label={`Focus score ${score} out of 100`}>
        {/* rotate(135°) points the arc's gap straight down */}
        <g transform="rotate(135 100 100)">
          <circle
            cx={100}
            cy={100}
            r={GAUGE_R}
            fill="none"
            stroke="#edeae3"
            strokeWidth={14}
            strokeLinecap="round"
            strokeDasharray={`${GAUGE_ARC} ${GAUGE_C}`}
          />
          {/* A zero-length dash with round caps still paints a dot — skip at 0. */}
          {clamped > 0 && (
            <circle
              className={styles.gaugeValue}
              cx={100}
              cy={100}
              r={GAUGE_R}
              fill="none"
              stroke={color}
              strokeWidth={14}
              strokeLinecap="round"
              strokeDasharray={`${filled} ${GAUGE_C}`}
            />
          )}
        </g>
      </svg>
      <div className={styles.gaugeCenter}>
        <span className={styles.gaugeScore} style={{ color }}>
          {score}
        </span>
        <span className={styles.gaugeOutOf}>focus score</span>
      </div>
    </div>
  );
}

/** The four components are raw floats off the wire — formatted here, the UI's job. */
const BREAKDOWN_ROWS: { key: keyof ScoreBreakdown; label: string; weight: string }[] = [
  { key: 'focusRatio', label: 'Focus ratio', weight: '45%' },
  { key: 'blockScore', label: 'Deep-work blocks', weight: '30%' },
  { key: 'meetingBalance', label: 'Meeting balance', weight: '15%' },
  { key: 'consistency', label: 'Consistency', weight: '10%' },
];

function BreakdownBars({ breakdown }: { breakdown: ScoreBreakdown }) {
  return (
    <div className={styles.breakdown}>
      <h2 className={styles.sectionTitle}>Why this score</h2>
      <ul>
        {BREAKDOWN_ROWS.map(({ key, label, weight }) => {
          const value = Math.max(0, Math.min(1, breakdown[key]));
          return (
            <li key={key}>
              <div className={styles.breakdownLabel}>
                <span>{label}</span>
                <span className={styles.muted}>
                  {percentLabel(value)} · weight {weight}
                </span>
              </div>
              <div className={styles.meter}>
                <div className={styles.meterFill} style={{ width: `${value * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatCards({ summary }: { summary: DailySummary }) {
  // The Tasks card is gated behind SHOW_TASKS — tasksCompleted has no real
  // source until Phase 7, so a "0" reads as failure. See lib/flags / stat-cards.
  const stats = buildStatCards(summary, SHOW_TASKS);
  return (
    <div className={styles.statGrid}>
      {stats.map(({ label, value, detail }) => (
        <div className={styles.stat} key={label}>
          <p className={styles.statLabel}>{label}</p>
          <p className={styles.statValue}>{value}</p>
          {detail && <p className={styles.statDetail}>{detail}</p>}
        </div>
      ))}
    </div>
  );
}

function HourlyChart({ hourly }: { hourly: number[] }) {
  // Floor the scale at 30 min so a nearly-empty day renders as small bars, not
  // misleading full-height towers.
  const max = Math.max(30, ...hourly);
  const BASE = 92; // chart baseline y; bars grow up to 72px tall above it

  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>Focus by hour</h2>
      <svg
        className={styles.hourChart}
        viewBox="0 0 480 112"
        role="img"
        aria-label="Focus minutes by hour of the day"
      >
        {hourly.map((minutes, hour) => {
          const h = minutes > 0 ? Math.max((minutes / max) * 72, 2) : 2;
          return (
            <rect
              key={hour}
              x={hour * 20 + 3}
              y={BASE - h}
              width={14}
              height={h}
              rx={3}
              fill={minutes > 0 ? '#6d4fe5' : '#edeae3'}
            >
              <title>{`${hourRangeLabel(hour)} — ${formatMinutes(minutes)} focus`}</title>
            </rect>
          );
        })}
        <line x1={0} y1={BASE + 5} x2={480} y2={BASE + 5} stroke="#e3dfd7" />
        {[0, 6, 12, 18].map((hour) => (
          <text key={hour} className={styles.axisLabel} x={hour * 20 + 3} y={108}>
            {hourTickLabel(hour)}
          </text>
        ))}
      </svg>
    </section>
  );
}

function PeakHours({ peakHours }: { peakHours: PeakHour[] }) {
  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>Peak hours</h2>
      {peakHours.length === 0 ? (
        <p className={styles.muted}>
          Not enough data yet — your most-focused hours show up after a few days of tracking.
        </p>
      ) : (
        <>
          <p className={styles.muted}>
            When you focus best, over the last 30 days. Guard these hours.
          </p>
          <ul className={styles.chips}>
            {peakHours.map((p) => (
              <li key={p.hour}>
                <strong>{hourRangeLabel(p.hour)}</strong> · {formatMinutes(p.focusMinutes)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function StreakCard({ streak }: { streak: Streak }) {
  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>Streak</h2>
      <p className={styles.bigStat}>
        {streak.count}
        <span>day{streak.count === 1 ? '' : 's'} at 60+</span>
      </p>
      <p className={styles.muted}>{streakMessage(streak)}</p>
    </section>
  );
}

function TrendCard({ trend }: { trend: Trend | null }) {
  if (!trend) {
    return (
      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>This week vs last</h2>
        <p className={styles.muted}>
          Need a bit more history to compare weeks — keep going and this fills in.
        </p>
      </section>
    );
  }

  const delta = Math.round(trend.delta);
  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>This week vs last</h2>
      <p className={styles.bigStat}>
        {Math.round(trend.thisWeek)}
        <span>avg score this week</span>
      </p>
      <p className={styles.muted}>
        Last week {Math.round(trend.lastWeek)} ·{' '}
        {delta === 0 ? (
          <span>holding steady</span>
        ) : delta > 0 ? (
          <span className={styles.deltaUp}>↑ {delta} points</span>
        ) : (
          <span className={styles.deltaDown}>↓ {Math.abs(delta)} points</span>
        )}
      </p>
    </section>
  );
}

function InsightsPlaceholder() {
  return (
    <section className={`${styles.card} ${styles.insights}`}>
      <h2 className={styles.sectionTitle}>Coaching insights</h2>
      <p className={styles.muted}>
        Coming soon — personalized, supportive suggestions drawn from your own patterns.
      </p>
    </section>
  );
}
