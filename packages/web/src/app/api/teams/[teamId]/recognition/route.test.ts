import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';
import { createServerClient } from '@/lib/auth/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { canManageTeam } from '@/lib/teams/manages';
import { loadTeamRecognitionEvents } from '@/lib/teams/recognition-load';
import type { RecognitionEvent } from '@/lib/teams/recognition';

vi.mock('@/lib/auth/server', () => ({ createServerClient: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/teams/manages', () => ({ canManageTeam: vi.fn() }));
vi.mock('@/lib/teams/recognition-load', () => ({ loadTeamRecognitionEvents: vi.fn() }));

const TEAM = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const DATE = '2026-06-18';

const EVENT: RecognitionEvent = {
  recipientId: 'a',
  name: 'Alice',
  type: 'streak-milestone',
  eventDate: DATE,
  eventKey: 'recognition:streak:5:2026-06-18',
  milestone: 5,
};

/** A fake admin that records any data write so "GET writes nothing" is assertable. */
function makeAdmin() {
  const upserts: unknown[] = [];
  const froms: string[] = [];
  return {
    _upserts: upserts,
    _froms: froms,
    from(table: string) {
      froms.push(table);
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        neq: () => b,
        gte: () => b,
        lte: () => b,
        order: () => b,
        upsert: (rows: unknown) => (upserts.push(rows), Promise.resolve({ error: null })),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
      };
      return b;
    },
  };
}

let admin: ReturnType<typeof makeAdmin>;

function setSession(user: { id: string } | null) {
  vi.mocked(createServerClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
  } as unknown as Awaited<ReturnType<typeof createServerClient>>);
}
const req = (date: string | null = DATE) =>
  new Request(`http://localhost/api/teams/${TEAM}/recognition${date === null ? '' : `?date=${date}`}`);
const ctx = (teamId = TEAM) => ({ params: Promise.resolve({ teamId }) });

beforeEach(() => {
  vi.clearAllMocks();
  admin = makeAdmin();
  vi.mocked(getSupabaseAdmin).mockReturnValue(admin as never);
});

describe('GET /api/teams/[teamId]/recognition — pure read', () => {
  it('200 returns cards AND WRITES NOTHING (prefetch-safe)', async () => {
    setSession({ id: USER });
    vi.mocked(canManageTeam).mockResolvedValue(true);
    vi.mocked(loadTeamRecognitionEvents).mockResolvedValue([EVENT]);

    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0].eventKey).toBe(EVENT.eventKey);
    expect(body.cards[0].title).toContain('Alice');

    // THE prefetch-safety property: a GET must not write a single notification.
    expect(admin._upserts).toEqual([]);
    expect(admin._froms).toEqual([]); // no direct admin I/O on the GET path at all
    expect(loadTeamRecognitionEvents).toHaveBeenCalledWith(admin, TEAM, USER, DATE);
  });

  it('403 for a foreign team — gate runs before any read (loader never called)', async () => {
    setSession({ id: USER });
    vi.mocked(canManageTeam).mockResolvedValue(false);

    const res = await GET(req(), ctx());
    expect(res.status).toBe(403);
    expect(loadTeamRecognitionEvents).not.toHaveBeenCalled(); // gate-before-read
    expect(admin._upserts).toEqual([]);
    const body = await res.json();
    expect(body).not.toHaveProperty('cards');
  });

  it('401 unauthenticated — never consults the gate or the loader', async () => {
    setSession(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(401);
    expect(canManageTeam).not.toHaveBeenCalled();
    expect(loadTeamRecognitionEvents).not.toHaveBeenCalled();
  });
});
