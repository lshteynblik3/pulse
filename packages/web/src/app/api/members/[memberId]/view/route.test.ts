import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as routeModule from './route';
import { POST } from './route';
import { createServerClient } from '@/lib/auth/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { canManageUser } from '@/lib/teams/manages';
import { getWorkSchedule } from '@/lib/work-schedule/loader';
import { DEFAULT_SCHEDULE } from '@pulse/shared';

vi.mock('@/lib/auth/server', () => ({ createServerClient: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/teams/manages', () => ({ canManageUser: vi.fn() }));
vi.mock('@/lib/work-schedule/loader', () => ({ getWorkSchedule: vi.fn() }));

const MEMBER = '33333333-3333-3333-3333-333333333333';
const USER = '22222222-2222-2222-2222-222222222222';
const DATE = '2026-06-18'; // Thursday

function sumRow(date: string) {
  const hourly = Array.from({ length: 24 }, () => 0);
  hourly[10] = 55;
  return {
    user_id: MEMBER,
    date,
    active_minutes: 300,
    focus_minutes: 285,
    meeting_minutes: 0,
    category_breakdown: { development: 285, communication: 0, creative: 0, admin: 0, browser: 0, entertainment: 0, other: 0 },
    focus_block_count: 5,
    focus_block_minutes: 240,
    hourly_focus_minutes: hourly,
    tasks_completed: 3,
    agent_version: 'test',
  };
}

interface AdminOpts {
  summaries?: unknown[];
  memberRow?: { display_name: string | null; email: string } | null;
  logError?: boolean;
  notifyError?: boolean;
  summariesError?: boolean;
}

let callLog: string[];
let upserts: Array<{ rows: unknown; opts: unknown }>;

function makeAdmin(opts: AdminOpts = {}) {
  const member = opts.memberRow ?? { display_name: 'Alice', email: 'alice@x.com' };
  return {
    from(table: string) {
      callLog.push(`from:${table}`);
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        gte: () => b,
        lte: () => b,
        order: () => b,
        maybeSingle: async () => ({ data: table === 'users' ? member : null, error: null }),
        insert: async () => {
          callLog.push(`insert:${table}`);
          return { error: opts.logError && table === 'access_logs' ? { message: 'boom' } : null };
        },
        upsert: async (rows: unknown, o: unknown) => {
          callLog.push(`upsert:${table}`);
          upserts.push({ rows, opts: o });
          return { error: opts.notifyError && table === 'notifications' ? { message: 'boom' } : null };
        },
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({
            data: table === 'daily_summaries' ? opts.summaries ?? [] : [],
            error: table === 'daily_summaries' && opts.summariesError ? { message: 'boom' } : null,
          }).then(res),
      };
      return b;
    },
  };
}

function setSession(user: { id: string } | null) {
  vi.mocked(createServerClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
  } as unknown as Awaited<ReturnType<typeof createServerClient>>);
}
const post = () =>
  new Request(`http://localhost/api/members/${MEMBER}/view`, {
    method: 'POST',
    body: JSON.stringify({ date: DATE }),
  });
const ctx = (memberId = MEMBER) => ({ params: Promise.resolve({ memberId }) });

function useAdmin(opts: AdminOpts = {}) {
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin(opts) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  callLog = [];
  upserts = [];
  vi.mocked(getWorkSchedule).mockResolvedValue({ schedule: DEFAULT_SCHEDULE, isDefault: true });
});

describe('POST /api/members/[memberId]/view — drill-in', () => {
  it('PREFETCH-SAFE: the route exposes no GET (only the deliberate POST writes/serves)', () => {
    expect((routeModule as Record<string, unknown>).GET).toBeUndefined();
    expect(typeof POST).toBe('function');
  });

  it('canManageUser runs FIRST: a foreign/non-managed member → 403, no read, no log, no notify', async () => {
    setSession({ id: USER });
    useAdmin({ summaries: [sumRow(DATE)] });
    vi.mocked(canManageUser).mockImplementation(async () => {
      callLog.push('gate');
      return false;
    });

    const res = await POST(post(), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).not.toHaveProperty('score'); // no detail leaked
    expect(canManageUser).toHaveBeenCalledWith(expect.anything(), USER, MEMBER);
    // No member data was read and nothing was written.
    expect(callLog).toEqual(['gate']);
  });

  it('401 unauthenticated — gate never consulted', async () => {
    setSession(null);
    useAdmin();
    const res = await POST(post(), ctx());
    expect(res.status).toBe(401);
    expect(canManageUser).not.toHaveBeenCalled();
  });

  it('success: order is gate → read → access_logs insert → notify upsert → serve', async () => {
    setSession({ id: USER });
    useAdmin({ summaries: [sumRow(DATE)] });
    vi.mocked(canManageUser).mockImplementation(async () => {
      callLog.push('gate');
      return true;
    });

    const res = await POST(post(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.score).not.toBeNull(); // real detail served
    expect(body.breakdown).toHaveProperty('focusRatio');

    // Strict ordering: gate first, then reads, then log, then notify.
    expect(callLog[0]).toBe('gate');
    expect(callLog.indexOf('gate')).toBeLessThan(callLog.indexOf('from:daily_summaries'));
    expect(callLog.indexOf('from:daily_summaries')).toBeLessThan(callLog.indexOf('insert:access_logs'));
    expect(callLog.indexOf('insert:access_logs')).toBeLessThan(callLog.indexOf('upsert:notifications'));

    // The access notification is coalesced + neutral.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.rows).toMatchObject({
      recipient_id: MEMBER,
      actor_id: USER,
      type: 'access',
      event_key: `access:${USER}:${MEMBER}:${DATE}`,
    });
    expect(upserts[0]!.opts).toEqual({ onConflict: 'recipient_id,event_key', ignoreDuplicates: true });
  });

  it('NO-DATA member still logs + notifies (no silent unlogged view)', async () => {
    setSession({ id: USER });
    useAdmin({ summaries: [] }); // member has no summary for the date
    vi.mocked(canManageUser).mockResolvedValue(true);

    const res = await POST(post(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasData).toBe(false);
    expect(body.score).toBeNull(); // calm empty state, not a fabricated zero
    // The deliberate view is recorded even with nothing to show.
    expect(callLog).toContain('insert:access_logs');
    expect(callLog).toContain('upsert:notifications');
  });

  it('LOG-BEFORE-REVEAL: access_logs write fails → 500, no detail, notify NOT attempted', async () => {
    setSession({ id: USER });
    useAdmin({ summaries: [sumRow(DATE)], logError: true });
    vi.mocked(canManageUser).mockResolvedValue(true);

    const res = await POST(post(), ctx());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).not.toHaveProperty('score');
    expect(callLog).toContain('insert:access_logs');
    expect(callLog).not.toContain('upsert:notifications'); // never reached the notify
  });

  it('notify write fails → 500, no detail (data never crosses the wire)', async () => {
    setSession({ id: USER });
    useAdmin({ summaries: [sumRow(DATE)], notifyError: true });
    vi.mocked(canManageUser).mockResolvedValue(true);

    const res = await POST(post(), ctx());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).not.toHaveProperty('score');
  });

  it('a member-data read failure 500s BEFORE any write (no false accountability notice)', async () => {
    setSession({ id: USER });
    useAdmin({ summariesError: true });
    vi.mocked(canManageUser).mockResolvedValue(true);

    const res = await POST(post(), ctx());
    expect(res.status).toBe(500);
    expect(callLog).not.toContain('insert:access_logs');
    expect(callLog).not.toContain('upsert:notifications');
  });

  it('coalescing: two views → two access_logs rows, but one coalesced notification key', async () => {
    setSession({ id: USER });
    vi.mocked(canManageUser).mockResolvedValue(true);

    useAdmin({ summaries: [sumRow(DATE)] });
    await POST(post(), ctx());
    const firstInserts = callLog.filter((c) => c === 'insert:access_logs').length;

    useAdmin({ summaries: [sumRow(DATE)] });
    await POST(post(), ctx());

    const totalLogInserts = callLog.filter((c) => c === 'insert:access_logs').length;
    expect(firstInserts).toBe(1);
    expect(totalLogInserts).toBe(2); // one audit row PER view
    // Both notify upserts carry the SAME event_key + ignoreDuplicates → DB coalesces to one row.
    expect(upserts).toHaveLength(2);
    expect(new Set(upserts.map((u) => (u.rows as { event_key: string }).event_key)).size).toBe(1);
    for (const u of upserts) {
      expect((u.opts as { ignoreDuplicates: boolean }).ignoreDuplicates).toBe(true);
    }
  });

  it('EXCLUSIONS: payload has no coaching insights / no categoryBreakdown; insights table never queried', async () => {
    setSession({ id: USER });
    useAdmin({ summaries: [sumRow(DATE)] });
    vi.mocked(canManageUser).mockResolvedValue(true);

    const res = await POST(post(), ctx());
    const body = await res.json();
    expect(body).not.toHaveProperty('insights');
    expect(JSON.stringify(body)).not.toContain('categoryBreakdown');
    expect(callLog).not.toContain('from:insights');
  });
});
