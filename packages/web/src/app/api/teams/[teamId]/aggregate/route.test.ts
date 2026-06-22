import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { GET } from './route';
import { createServerClient } from '@/lib/auth/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { canManageTeam } from '@/lib/teams/manages';
import { getWorkSchedule } from '@/lib/work-schedule/loader';

// First route-handler test in the repo — establishes the vi.mock harness. We mock
// the I/O seams (session client, admin client, the manages gate, schedule loader)
// and let the REAL pure aggregator run, so this proves authorization + wiring, and
// aggregate.test.ts proves the math.
vi.mock('@/lib/auth/server', () => ({ createServerClient: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/teams/manages', () => ({ canManageTeam: vi.fn() }));
vi.mock('@/lib/work-schedule/loader', () => ({ getWorkSchedule: vi.fn() }));

const TEAM = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const DATE = '2026-06-18';

// Shared ordered log of side effects: the gate pushes 'gate', every admin table
// read pushes 'from:<table>'. The gate-before-read property is exactly
// callLog[0] === 'gate' with all 'from:' entries after it.
let callLog: string[] = [];

/** A scorable working-day daily_summaries ROW (snake_case, as supabase-js returns). */
function sumRow(date: string) {
  const hourly = Array.from({ length: 24 }, () => 0);
  hourly[10] = 55;
  hourly[14] = 50;
  return {
    user_id: 'm',
    date,
    active_minutes: 240,
    focus_minutes: 210,
    meeting_minutes: 0,
    category_breakdown: { development: 210, communication: 30, creative: 0, admin: 0, browser: 0, entertainment: 0, other: 0 },
    focus_block_count: 4,
    focus_block_minutes: 180,
    hourly_focus_minutes: hourly,
    tasks_completed: 0,
    agent_version: 'test',
  };
}

/** A thenable supabase-js-style admin client over canned per-table results. */
function makeAdmin(results: Record<string, { data: unknown; error: unknown }>) {
  return {
    from(table: string) {
      callLog.push(`from:${table}`);
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        lte: () => builder,
        order: () => builder,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve, reject),
      };
      return builder;
    },
  };
}

function setSession(user: { id: string } | null) {
  vi.mocked(createServerClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
  } as unknown as Awaited<ReturnType<typeof createServerClient>>);
}

function req(date: string | null = DATE) {
  const qs = date === null ? '' : `?date=${date}`;
  return new Request(`http://localhost/api/teams/${TEAM}/aggregate${qs}`);
}
const ctx = (teamId = TEAM) => ({ params: Promise.resolve({ teamId }) });

beforeEach(() => {
  vi.clearAllMocks();
  callLog = [];
  vi.mocked(getWorkSchedule).mockResolvedValue({ schedule: DEFAULT_SCHEDULE, isDefault: true });
});

describe('GET /api/teams/[teamId]/aggregate', () => {
  it('401 when unauthenticated — and the gate is never consulted', async () => {
    setSession(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(401);
    expect(canManageTeam).not.toHaveBeenCalled();
    expect(callLog).toEqual([]); // no data read
  });

  it('403 for a team the manager does not manage — body has NO aggregate data, and no data was read', async () => {
    setSession({ id: USER });
    vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin({}) as never);
    vi.mocked(canManageTeam).mockResolvedValue(false); // foreign team

    const res = await GET(req(), ctx());
    expect(res.status).toBe(403);

    const body = await res.json();
    // The 403 leaks nothing: no aggregate, no count, no state.
    expect(body).not.toHaveProperty('state');
    expect(body).not.toHaveProperty('reportingMembers');
    expect(body).not.toHaveProperty('avgFocusScore');
    expect(body).not.toHaveProperty('avgMeetingMinutes');
    expect(body).not.toHaveProperty('activeStreakCount');

    // The gate ran on the SESSION identity + the path teamId, and NO team data was read.
    expect(canManageTeam).toHaveBeenCalledWith(expect.anything(), USER, TEAM);
    expect(callLog.filter((c) => c.startsWith('from:'))).toEqual([]);
  });

  it('200 with team aggregates for a managed team', async () => {
    setSession({ id: USER });
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      makeAdmin({
        users: { data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], error: null },
        daily_summaries: { data: [sumRow(DATE)], error: null },
      }) as never,
    );
    vi.mocked(canManageTeam).mockImplementation(async () => {
      callLog.push('gate');
      return true;
    });

    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.state).toBe('populated');
    expect(body.reportingMembers).toBe(3);
    expect(body.window).toEqual({ start: '2026-06-12', end: DATE });
    expect(typeof body.activeStreakCount).toBe('number');
  });

  it('GATE RUNS FIRST: canManageTeam is called before any admin data read', async () => {
    setSession({ id: USER });
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      makeAdmin({
        users: { data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], error: null },
        daily_summaries: { data: [sumRow(DATE)], error: null },
      }) as never,
    );
    vi.mocked(canManageTeam).mockImplementation(async () => {
      callLog.push('gate');
      return true;
    });

    await GET(req(), ctx());

    // The property that protects this endpoint: the gate is the FIRST side effect,
    // strictly before any 'from:<table>' read. A refactor that reads team data
    // before authorizing flips this order and fails the test.
    expect(callLog[0]).toBe('gate');
    expect(callLog.indexOf('gate')).toBeLessThan(callLog.indexOf('from:users'));
  });

  it('400 for a malformed teamId — before any gate or read', async () => {
    setSession({ id: USER });
    const res = await GET(req(), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(canManageTeam).not.toHaveBeenCalled();
  });
});
