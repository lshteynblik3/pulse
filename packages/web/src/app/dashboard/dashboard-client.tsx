'use client';

import { useCallback, useEffect, useState } from 'react';
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
  scoreColor,
  scoreMessage,
  streakMessage,
} from '@/lib/dashboard/format';
import styles from './dashboard.module.css';

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
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(() => {
    setState({ status: 'loading' });
    const controller = new AbortController();
    // "Today" originates HERE, from the browser's local clock components —
    // never toISOString() (UTC) and never the server's clock. Recomputed on
    // every load/retry so a tab left open across midnight fetches the new day.
    const date = localDateString(new Date());
    fetch(`/api/dashboard?date=${date}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`dashboard responded ${res.status}`);
        return (await res.json()) as DashboardPayload;
      })
      .then((payload) => setState({ status: 'ready', payload }))
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setState({ status: 'error' });
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => load(), [load]);

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
            <button className={styles.retry} onClick={() => load()}>
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
      <Link href="/settings/work-schedule">Set your real schedule</Link> so days off never
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
        <Link href="/settings/devices">Settings → Devices</Link>.
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
  const stats: { label: string; value: string; detail?: string }[] = [
    { label: 'Active time', value: formatMinutes(summary.activeMinutes) },
    { label: 'Focus time', value: formatMinutes(summary.focusMinutes) },
    { label: 'Meetings', value: formatMinutes(summary.meetingMinutes) },
    {
      label: 'Focus blocks',
      value: String(summary.focusBlockCount),
      detail: `${formatMinutes(summary.focusBlockMinutes)} inside blocks`,
    },
    { label: 'Tasks done', value: String(summary.tasksCompleted) },
  ];
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
