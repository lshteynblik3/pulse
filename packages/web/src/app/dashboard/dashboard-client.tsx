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
import type { DashboardPayload, WeekSummary } from '@/lib/dashboard/compute';
import type { Insight } from '@/lib/insights/schema';
import {
  displayScore,
  formatDateHeading,
  formatDateShort,
  formatMinutes,
  hourRangeLabel,
  hourTickLabel,
  localDateString,
  percentLabel,
  relativeDayLabel,
  relativeTimeLabel,
  scoreColor,
  scoreMessage,
  shiftDate,
  streakMessage,
  trendDisplay,
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
  // The browser's actual local today, captured once — the forward nav cap.
  const [actualToday] = useState(() => localDateString(new Date()));
  const [viewedDate, setViewedDate] = useState(actualToday);
  // Day view vs the rolling-week summary. Both come from one payload, so the
  // toggle never refetches.
  const [view, setView] = useState<'day' | 'week'>('day');
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

  // Nav bounds: can't go past today (no future data); backward floor is a fixed
  // 365 days (a generous "review the past year"; beyond that is empty states
  // anyway). The picker enforces the same range as the arrows.
  const floor = shiftDate(actualToday, -365);
  const atToday = viewedDate >= actualToday;
  const atFloor = viewedDate <= floor;
  const relTag = relativeDayLabel(viewedDate, actualToday);
  const ready = state.status === 'ready' ? state.payload : null;

  return (
    <div className={styles.shell}>
      <header>
        <p className={styles.kicker}>{view === 'week' ? 'Your week' : 'Your day'}</p>
        <h1 className={styles.dateHeading}>
          {view === 'week'
            ? // Rolling week ends on the viewed day, starts 6 days before
              // (WEEK_WINDOW_DAYS − 1). Derived here so it's stable during loads.
              `${formatDateShort(shiftDate(viewedDate, -6))} – ${formatDateShort(viewedDate)}`
            : formatDateHeading(viewedDate)}
          {view === 'day' && relTag && <span className={styles.dayTag}>{relTag}</span>}
        </h1>
        {ready && (
          <p className={styles.lastActivity}>
            {ready.agent.lastActivityAt
              ? `Agent last posted ${relativeTimeLabel(ready.agent.lastActivityAt)}`
              : 'No agent has posted yet'}
          </p>
        )}
        {ready && lastUpdatedAt && (
          <p className={styles.freshness}>Updated {relativeTimeLabel(lastUpdatedAt)}</p>
        )}
      </header>

      <div className={styles.controls}>
        <div className={styles.dateNav}>
          <button
            className={styles.navArrow}
            onClick={() => !atFloor && setViewedDate(shiftDate(viewedDate, -1))}
            disabled={atFloor}
            aria-label="Previous day"
          >
            ‹
          </button>
          <input
            className={styles.datePicker}
            type="date"
            value={viewedDate}
            min={floor}
            max={actualToday}
            onChange={(e) => {
              const v = e.target.value;
              if (v && v >= floor && v <= actualToday) setViewedDate(v);
            }}
            aria-label="Pick a day"
          />
          <button
            className={styles.navArrow}
            onClick={() => !atToday && setViewedDate(shiftDate(viewedDate, 1))}
            disabled={atToday}
            aria-label="Next day"
          >
            ›
          </button>
          {!atToday && (
            <button className={styles.todayBtn} onClick={() => setViewedDate(actualToday)}>
              Today
            </button>
          )}
        </div>

        <div className={styles.viewToggle} role="tablist" aria-label="Day or week view">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'day'}
            className={view === 'day' ? styles.viewActive : undefined}
            onClick={() => setView('day')}
          >
            Day
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'week'}
            className={view === 'week' ? styles.viewActive : undefined}
            onClick={() => setView('week')}
          >
            Week
          </button>
        </div>
      </div>

      {state.status === 'loading' && (
        <p className={styles.muted}>Loading your {view === 'week' ? 'week' : 'day'}…</p>
      )}

      {state.status === 'error' && (
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
      )}

      {ready && view === 'day' && <DayView payload={ready} isToday={atToday} />}
      {ready && view === 'week' && <WeekView week={ready.week} />}
    </div>
  );
}

function DayView({ payload, isToday }: { payload: DashboardPayload; isToday: boolean }) {
  const { summary, focus, isWorkingDay } = payload.today;
  return (
    <>
      {payload.schedule.isDefault && <DefaultScheduleBanner />}

      {/* Only the HERO branches on working status — a non-working day never shows
          a score (a score there reads as judgment for a day that shouldn't be
          judged). Activity, if any, still renders below: the same story the week
          summary tells — non-working = no score, but the activity is real. */}
      {!isWorkingDay ? (
        summary ? (
          <DayOffWorked />
        ) : (
          <NotWorkingDay />
        )
      ) : summary && focus ? (
        <FocusHero focus={focus} />
      ) : (
        <EmptyHero isToday={isToday} />
      )}

      {/* Activity shows whenever there's a summary — including a worked day off. */}
      {summary && <StatCards summary={summary} />}
      {summary && <HourlyChart hourly={summary.hourlyFocusMinutes} />}

      <PeakHours peakHours={payload.peakHours} />

      <div className={styles.duo}>
        <StreakCard streak={payload.streak} />
        <TrendCard trend={payload.trend} />
      </div>

      <InsightsCard insights={payload.insights} />
    </>
  );
}

/**
 * Placeholder for the planned per-date schedule-override feature (its own future
 * phase). Intentionally INERT — it must never write anything, mutate the
 * schedule, or touch isWorkingDay/scoring. Display affordance only, to signal
 * the coming feature; disabled so a click does nothing.
 */
function MarkAsWorkingDayButton() {
  return (
    <button type="button" className={styles.stubButton} disabled aria-disabled="true">
      Mark as working day
      <span className={styles.stubNote}>coming soon</span>
    </button>
  );
}

/** Non-working day, no activity — a calm "no score here" state, never a zero. */
function NotWorkingDay() {
  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>Not a working day</h2>
      <p className={styles.muted}>
        This isn&apos;t a working day on your schedule, so there&apos;s no focus score — rest
        counts too. If you did work, tracking still runs; it just isn&apos;t judged.
      </p>
      <div className={styles.stubRow}>
        <MarkAsWorkingDayButton />
      </div>
    </section>
  );
}

/** Non-working day with a summary: show the work honestly, but no score applied. */
function DayOffWorked() {
  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>You worked on a day off</h2>
      <p className={styles.muted}>
        Here&apos;s what you did. It doesn&apos;t count against your scores or streak — a day
        off you chose to work is still a day off.
      </p>
      <div className={styles.stubRow}>
        <MarkAsWorkingDayButton />
      </div>
    </section>
  );
}

/** A small presentational stat card (week view reuses the day's .stat styling). */
function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className={styles.stat}>
      <p className={styles.statLabel}>{label}</p>
      <p className={styles.statValue}>{value}</p>
      {detail && <p className={styles.statDetail}>{detail}</p>}
    </div>
  );
}

function WeekView({ week }: { week: WeekSummary }) {
  // bestDay === null ⟺ no day in the window had data: a calm empty week, not zeros.
  if (week.bestDay === null) {
    return (
      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>No focus data this week yet</h2>
        <p className={styles.muted}>
          Once the agent has run on a day in this week, your week summary takes shape here.
          A quiet week is a quiet week, not a problem.
        </p>
      </section>
    );
  }

  // Color + band copy key off the RAW score; only the rendered number is the
  // /130 display value (displayScore). scoreColor/scoreMessage never see ×1.3.
  const raw = week.score !== null ? Math.round(week.score) : null;

  return (
    <>
      <section className={`${styles.card} ${styles.weekHero}`}>
        <div className={styles.weekScoreWrap}>
          <span
            className={styles.weekScore}
            style={{ color: raw !== null ? scoreColor(raw) : '#9b97a6' }}
          >
            {week.score !== null ? displayScore(week.score) : '—'}
          </span>
          <span className={styles.gaugeOutOf}>week focus score</span>
          {/* The honesty line: what the average is actually over. Prominent, by design. */}
          <p className={styles.weekTracked}>
            {week.workingDaysTracked} of {week.workingDaysInWindow} working days tracked
          </p>
        </div>
        {raw !== null && <p className={styles.scoreMessage}>{scoreMessage(raw)}</p>}
      </section>

      <div className={styles.statGrid}>
        <Stat label="Total focus" value={formatMinutes(week.totalFocusMinutes)} />
        <Stat
          label="Avg / tracked day"
          value={week.avgFocusMinutes !== null ? formatMinutes(week.avgFocusMinutes) : '—'}
        />
        <Stat label="Focus blocks" value={String(week.totalFocusBlocks)} />
      </div>

      {/* A celebration, never a ranking — there is deliberately no "worst day". */}
      <section className={`${styles.card} ${styles.bestDay}`}>
        <h2 className={styles.sectionTitle}>Your strongest day</h2>
        <p className={styles.bigStat} style={{ color: scoreColor(Math.round(week.bestDay.score)) }}>
          {displayScore(week.bestDay.score)}
          <span>on {formatDateShort(week.bestDay.date)}</span>
        </p>
        <p className={styles.muted}>A high point worth repeating.</p>
      </section>

      <PeakHours peakHours={week.peakHours} />
    </>
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

/** No data is a calm state, not an error — and not zeros pretending to be real. */
function EmptyHero({ isToday }: { isToday: boolean }) {
  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>
        {isToday ? 'No data from today yet' : 'No data for this day'}
      </h2>
      <p className={styles.muted}>
        {isToday ? (
          <>
            Once the Pulse agent has been running on this account&apos;s machine, today&apos;s
            focus score and hours show up here. If it&apos;s been a while, check{' '}
            <Link href="/settings#devices">Settings → Devices</Link>.
          </>
        ) : (
          <>
            The agent didn&apos;t post a summary for this day — a day off, or a machine that
            wasn&apos;t running, is a perfectly normal gap, not a problem.
          </>
        )}
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
  // Arc + color key off the RAW score (raw/100 == displayScore/130, so the arc
  // is unchanged); only the rendered number is the /130 display value.
  const clamped = Math.max(0, Math.min(100, score));
  const filled = (clamped / 100) * GAUGE_ARC;
  const color = scoreColor(score);
  return (
    <div className={styles.gauge}>
      <svg
        viewBox="0 0 200 200"
        role="img"
        aria-label={`Focus score ${displayScore(score)} out of 130`}
      >
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
          {displayScore(score)}
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

  // Both weeks on the /130 display scale; the "points" delta is the difference
  // of the two DISPLAYED numbers (see trendDisplay) so the on-screen arithmetic
  // is self-consistent. Extracted/pure so the near-flat rounding is unit-tested.
  const { thisWeek, lastWeek, delta } = trendDisplay(trend);
  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>This week vs last</h2>
      <p className={styles.bigStat}>
        {thisWeek}
        <span>avg score this week</span>
      </p>
      <p className={styles.muted}>
        Last week {lastWeek} ·{' '}
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

/**
 * Coaching insights. The payload's `insights` are EITHER stored LLM cards (paid
 * users, once the nightly collect cron ran) OR the deterministic computed tips
 * (free users, pre-collect days, or per-user LLM failures) — the API decided,
 * and they share one {type,title,body} shape, so this component renders both
 * identically and can't tell which it got. No LLM call happens here or anywhere
 * in the dashboard request path.
 */
function InsightsCard({ insights }: { insights: Insight[] }) {
  return (
    <section className={`${styles.card} ${styles.insights}`}>
      <h2 className={styles.sectionTitle}>Coaching insights</h2>
      <ul className={styles.insightList}>
        {insights.map((insight, i) => (
          <li key={i} className={styles.insightItem}>
            <h3 className={styles.insightTitle}>{insight.title}</h3>
            <p className={styles.insightBody}>{insight.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
