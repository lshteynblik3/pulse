'use client';

import { useEffect, useState } from 'react';
import type { Category, DailySummary } from '@pulse/shared';

type SummaryResponse = { summary: DailySummary | null };

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; summary: DailySummary | null };

const CATEGORY_ORDER: Category[] = [
  'development',
  'communication',
  'creative',
  'admin',
  'browser',
  'other',
];

export default function DashboardPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    fetch('/api/summary/today')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return (await res.json()) as SummaryResponse;
      })
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', summary: data.summary });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 680 }}>
      <h1>Today</h1>
      {state.status === 'loading' && <p>Loading…</p>}
      {state.status === 'error' && <p>Could not load summary: {state.message}</p>}
      {state.status === 'ready' &&
        (state.summary ? <Summary summary={state.summary} /> : <EmptyState />)}
    </main>
  );
}

function EmptyState() {
  return (
    <p>
      No summary yet. Run the agent (or POST a DailySummary to <code>/api/ingest</code>) and
      refresh to see your day here.
    </p>
  );
}

function Summary({ summary }: { summary: DailySummary }) {
  return (
    <>
      <p>
        <strong>{summary.date}</strong>
      </p>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        <li>Active: {round(summary.activeMinutes)} min</li>
        <li>Focus: {round(summary.focusMinutes)} min</li>
        <li>
          Focus blocks: {summary.focusBlockCount} ({round(summary.focusBlockMinutes)} min)
        </li>
      </ul>

      <h2 style={{ fontSize: 16 }}>By category</h2>
      <CategoryBars breakdown={summary.categoryBreakdown} />

      <h2 style={{ fontSize: 16, marginTop: 20 }}>Focus by hour</h2>
      <HourlyChart hourly={summary.hourlyFocusMinutes} />
    </>
  );
}

function CategoryBars({ breakdown }: { breakdown: Record<Category, number> }) {
  const max = Math.max(0, ...CATEGORY_ORDER.map((c) => breakdown[c] ?? 0));

  return (
    <ul style={{ listStyle: 'none', padding: 0 }}>
      {CATEGORY_ORDER.map((category) => {
        const minutes = breakdown[category] ?? 0;
        const width = max > 0 ? (minutes / max) * 100 : 0;
        return (
          <li key={category} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 13 }}>
              {category} — {round(minutes)} min
            </div>
            <div
              style={{ height: 10, width: `${width}%`, minWidth: minutes > 0 ? 2 : 0, background: '#6d4fe5' }}
            />
          </li>
        );
      })}
    </ul>
  );
}

function HourlyChart({ hourly }: { hourly: number[] }) {
  const max = Math.max(0, ...hourly);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 80 }}>
      {hourly.map((minutes, hour) => {
        const heightPct = max > 0 ? (minutes / max) * 100 : 0;
        return (
          <div
            key={hour}
            title={`${String(hour).padStart(2, '0')}:00 — ${round(minutes)} min`}
            style={{
              flex: 1,
              height: `${heightPct}%`,
              minHeight: minutes > 0 ? 2 : 0,
              background: '#6d4fe5',
            }}
          />
        );
      })}
    </div>
  );
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
