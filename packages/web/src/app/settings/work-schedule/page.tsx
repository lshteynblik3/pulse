import { requireUser } from '@/lib/auth/server';
import WorkScheduleClient from './work-schedule-client';

/**
 * /settings/work-schedule — working days, daily hours target, vacations, breaks.
 *
 * Server component shell, same as /settings/devices: requireUser() (plus the
 * /settings/* middleware) gates the page; everything interactive lives in the
 * client component, which talks to /api/work-schedule.
 */
export default async function WorkSchedulePage() {
  await requireUser();

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 560 }}>
      <h1>Work schedule</h1>
      <p style={{ color: '#555' }}>
        Tell Pulse when you actually work. Scoring judges consistency and streaks against
        these days — vacation days are never counted against you.
      </p>
      <WorkScheduleClient />
    </main>
  );
}
