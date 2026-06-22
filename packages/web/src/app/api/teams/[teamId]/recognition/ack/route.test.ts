import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';
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
const KEY_A = 'recognition:streak:5:2026-06-18';

const REAL_EVENT: RecognitionEvent = {
  recipientId: 'member-a',
  name: 'Alice',
  type: 'streak-milestone',
  eventDate: DATE,
  eventKey: KEY_A,
  milestone: 5,
};

interface UpsertCall {
  rows: Array<Record<string, unknown>>;
  opts: { onConflict?: string; ignoreDuplicates?: boolean };
}

function makeAdmin() {
  const upserts: UpsertCall[] = [];
  return {
    _upserts: upserts,
    from() {
      const b: Record<string, unknown> = {
        upsert: (rows: UpsertCall['rows'], opts: UpsertCall['opts']) => {
          upserts.push({ rows, opts });
          return Promise.resolve({ error: null });
        },
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
const post = (eventKeys: string[]) =>
  new Request(`http://localhost/api/teams/${TEAM}/recognition/ack`, {
    method: 'POST',
    body: JSON.stringify({ date: DATE, eventKeys }),
  });
const ctx = (teamId = TEAM) => ({ params: Promise.resolve({ teamId }) });

beforeEach(() => {
  vi.clearAllMocks();
  admin = makeAdmin();
  vi.mocked(getSupabaseAdmin).mockReturnValue(admin as never);
});

describe('POST /api/teams/[teamId]/recognition/ack — the notify writer', () => {
  it('writes one idempotent notification per VALID event_key', async () => {
    setSession({ id: USER });
    vi.mocked(canManageTeam).mockResolvedValue(true);
    vi.mocked(loadTeamRecognitionEvents).mockResolvedValue([REAL_EVENT]);

    const res = await POST(post([KEY_A]), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).acknowledged).toBe(1);

    expect(admin._upserts).toHaveLength(1);
    const call = admin._upserts[0]!;
    expect(call.rows.map((r) => r.event_key)).toEqual([KEY_A]);
    expect(call.rows[0]).toMatchObject({ recipient_id: 'member-a', actor_id: USER, type: 'recognition' });
    // The idempotency guarantee — ON CONFLICT DO NOTHING on (recipient_id, event_key).
    expect(call.opts).toEqual({ onConflict: 'recipient_id,event_key', ignoreDuplicates: true });
  });

  it('REJECTS a fabricated event_key that matches no real current event — NO insert for it', async () => {
    setSession({ id: USER });
    vi.mocked(canManageTeam).mockResolvedValue(true);
    vi.mocked(loadTeamRecognitionEvents).mockResolvedValue([REAL_EVENT]);

    // One real key + one fabricated; then a pure-fabrication request.
    const mixed = await POST(post([KEY_A, 'recognition:streak:999:2026-06-18']), ctx());
    const mixedBody = await mixed.json();
    expect(mixedBody.acknowledged).toBe(1);
    expect(mixedBody.rejected).toBe(1);
    expect(admin._upserts[0]!.rows.map((r) => r.event_key)).toEqual([KEY_A]); // fabricated absent

    admin = makeAdmin();
    vi.mocked(getSupabaseAdmin).mockReturnValue(admin as never);
    const fake = await POST(post(['recognition:fabricated:1']), ctx());
    const fakeBody = await fake.json();
    expect(fakeBody.acknowledged).toBe(0);
    expect(admin._upserts).toEqual([]); // a non-event triggers no write whatsoever
  });

  it('re-POST of the same key issues the same idempotent upsert (DB dedups to one row)', async () => {
    setSession({ id: USER });
    vi.mocked(canManageTeam).mockResolvedValue(true);
    vi.mocked(loadTeamRecognitionEvents).mockResolvedValue([REAL_EVENT]);

    await POST(post([KEY_A]), ctx());
    await POST(post([KEY_A]), ctx());
    expect(admin._upserts).toHaveLength(2);
    for (const call of admin._upserts) {
      expect(call.opts.ignoreDuplicates).toBe(true); // the constraint, not the route, prevents the dupe
    }
  });

  it('403 for a foreign team — gate before any write, loader never called', async () => {
    setSession({ id: USER });
    vi.mocked(canManageTeam).mockResolvedValue(false);

    const res = await POST(post([KEY_A]), ctx());
    expect(res.status).toBe(403);
    expect(loadTeamRecognitionEvents).not.toHaveBeenCalled();
    expect(admin._upserts).toEqual([]); // gate-before-write
  });

  it('401 unauthenticated — no gate, no write', async () => {
    setSession(null);
    const res = await POST(post([KEY_A]), ctx());
    expect(res.status).toBe(401);
    expect(canManageTeam).not.toHaveBeenCalled();
    expect(admin._upserts).toEqual([]);
  });
});
