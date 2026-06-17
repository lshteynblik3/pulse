import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { getWorkSchedule } from './loader';

/**
 * A minimal fake of the one supabase-js call chain the loader makes
 * (.from().select().eq().maybeSingle()), so stored-vs-default logic is testable
 * without a database. The fake records the filter args to prove the query is
 * scoped to the requested user.
 */
function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Record<string, unknown[]> = {};
  const chain = {
    from: (...args: unknown[]) => ((calls.from = args), chain),
    select: (...args: unknown[]) => ((calls.select = args), chain),
    eq: (...args: unknown[]) => ((calls.eq = args), chain),
    maybeSingle: async () => result,
  };
  return { client: chain as unknown as SupabaseClient, calls };
}

const storedRow = {
  user_id: 'user-1',
  working_days: [2, 4, 6],
  daily_hours: 6,
  vacation_dates: ['2026-08-10'],
  breaks: [{ label: 'Lunch', start: '12:00', end: '13:00' }],
};

describe('getWorkSchedule', () => {
  it('returns the stored schedule with isDefault: false', async () => {
    const { client, calls } = fakeClient({ data: storedRow, error: null });
    const result = await getWorkSchedule(client, 'user-1');
    expect(result).toEqual({
      schedule: {
        workingDays: [2, 4, 6],
        dailyHours: 6,
        vacationDates: ['2026-08-10'],
        breaks: [{ label: 'Lunch', start: '12:00', end: '13:00' }],
      },
      isDefault: false,
    });
    expect(calls.from).toEqual(['work_schedules']);
    expect(calls.eq).toEqual(['user_id', 'user-1']); // app-level ownership scoping
  });

  it('returns the one shared DEFAULT_SCHEDULE when no row exists', async () => {
    const { client } = fakeClient({ data: null, error: null });
    const result = await getWorkSchedule(client, 'user-1');
    expect(result.isDefault).toBe(true);
    // Identity, not just equality: UI and scoring must share the same default.
    expect(result.schedule).toBe(DEFAULT_SCHEDULE);
  });

  it('throws on a query error instead of silently defaulting', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    await expect(getWorkSchedule(client, 'user-1')).rejects.toThrow(/Could not load/);
  });
});
