'use client';

import { useEffect, useState } from 'react';

// Shape returned by GET /api/summary/today (Phase 1).
type SummaryResponse = {
  date: string;
  totalMinutes: number;
  apps: { appName: string; minutes: number }[];
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SummaryResponse };

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
        if (!cancelled) setState({ status: 'ready', data });
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
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 640 }}>
      <h1>Today</h1>
      {state.status === 'loading' && <p>Loading…</p>}
      {state.status === 'error' && <p>Could not load summary: {state.message}</p>}
      {state.status === 'ready' && <Summary data={state.data} />}
    </main>
  );
}

function Summary({ data }: { data: SummaryResponse }) {
  const { date, totalMinutes, apps } = data;

  return (
    <>
      <p>
        <strong>{date}</strong> — {totalMinutes} total minutes tracked
      </p>

      {apps.length === 0 ? (
        <p>No activity tracked yet today. Run the agent and refresh to see your apps here.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {apps.map((app) => (
            <li key={app.appName} style={{ marginBottom: 8 }}>
              <div>
                {app.appName} — {app.minutes} min
              </div>
              {/* Simple proportional bar (width relative to the busiest app). */}
              <div
                style={{
                  height: 12,
                  width: `${barWidthPercent(app.minutes, apps)}%`,
                  minWidth: 2,
                  background: '#6d4fe5',
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function barWidthPercent(minutes: number, apps: SummaryResponse['apps']): number {
  const max = Math.max(...apps.map((a) => a.minutes));
  if (max <= 0) return 0;
  return (minutes / max) * 100;
}
