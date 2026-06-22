import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canManageUser, canManageTeam } from './manages';

/**
 * A minimal fake of the admin client's call chain
 * (.from(table).select(...).eq('id', id).maybeSingle()), keyed by table + id, so
 * the manages rules are testable without a database. Returns undefined-row (null)
 * for any id not present, exercising the "target/team missing → false" paths.
 */
type Rows = Record<string, Record<string, unknown>>;
function fakeAdmin(tables: { users?: Rows; teams?: Rows }) {
  let table = '';
  let id = '';
  const chain = {
    from: (t: string) => ((table = t), chain),
    select: () => chain,
    eq: (_col: string, v: string) => ((id = v), chain),
    maybeSingle: async () => {
      const row = (tables as Record<string, Rows>)[table]?.[id] ?? null;
      return { data: row, error: null };
    },
  };
  return chain as unknown as SupabaseClient;
}

describe('canManageUser', () => {
  it('manager manages a same-team user (true)', async () => {
    const admin = fakeAdmin({
      users: {
        mgr: { role: 'manager', org_id: 'o1', team_id: 't1' },
        tgt: { role: 'member', org_id: 'o1', team_id: 't1' },
      },
    });
    expect(await canManageUser(admin, 'mgr', 'tgt')).toBe(true);
  });

  it('manager does NOT manage an other-team user (false)', async () => {
    const admin = fakeAdmin({
      users: {
        mgr: { role: 'manager', org_id: 'o1', team_id: 't1' },
        tgt: { role: 'member', org_id: 'o1', team_id: 't2' },
      },
    });
    expect(await canManageUser(admin, 'mgr', 'tgt')).toBe(false);
  });

  it('admin manages a same-org user even on a different team (true)', async () => {
    const admin = fakeAdmin({
      users: {
        adm: { role: 'admin', org_id: 'o1', team_id: null },
        tgt: { role: 'member', org_id: 'o1', team_id: 't9' },
      },
    });
    expect(await canManageUser(admin, 'adm', 'tgt')).toBe(true);
  });

  it('admin does NOT manage a cross-org user (false)', async () => {
    const admin = fakeAdmin({
      users: {
        adm: { role: 'admin', org_id: 'o1', team_id: 't1' },
        tgt: { role: 'member', org_id: 'o2', team_id: 't2' },
      },
    });
    expect(await canManageUser(admin, 'adm', 'tgt')).toBe(false);
  });

  it('admin with NULL team_id but valid org STILL manages (role-specific gate)', async () => {
    const admin = fakeAdmin({
      users: {
        adm: { role: 'admin', org_id: 'o1', team_id: null },
        tgt: { role: 'member', org_id: 'o1', team_id: 't1' },
      },
    });
    expect(await canManageUser(admin, 'adm', 'tgt')).toBe(true);
  });

  it('manager with NULL team_id manages nobody (false)', async () => {
    const admin = fakeAdmin({
      users: {
        mgr: { role: 'manager', org_id: 'o1', team_id: null },
        tgt: { role: 'member', org_id: 'o1', team_id: 't1' },
      },
    });
    expect(await canManageUser(admin, 'mgr', 'tgt')).toBe(false);
  });

  it('a plain member manages nobody (false)', async () => {
    const admin = fakeAdmin({
      users: {
        me: { role: 'member', org_id: 'o1', team_id: 't1' },
        tgt: { role: 'member', org_id: 'o1', team_id: 't1' },
      },
    });
    expect(await canManageUser(admin, 'me', 'tgt')).toBe(false);
  });

  it('a null-everything actor manages nobody (false)', async () => {
    const admin = fakeAdmin({
      users: {
        ghost: { role: null, org_id: null, team_id: null },
        tgt: { role: 'member', org_id: 'o1', team_id: 't1' },
      },
    });
    expect(await canManageUser(admin, 'ghost', 'tgt')).toBe(false);
  });

  it('a missing actor row manages nobody (false)', async () => {
    const admin = fakeAdmin({ users: { tgt: { role: 'member', org_id: 'o1', team_id: 't1' } } });
    expect(await canManageUser(admin, 'nope', 'tgt')).toBe(false);
  });

  it('a missing target row is not managed (false)', async () => {
    const admin = fakeAdmin({ users: { mgr: { role: 'manager', org_id: 'o1', team_id: 't1' } } });
    expect(await canManageUser(admin, 'mgr', 'ghost')).toBe(false);
  });
});

describe('canManageTeam', () => {
  it('manager manages its own team (true)', async () => {
    const admin = fakeAdmin({ users: { mgr: { role: 'manager', org_id: 'o1', team_id: 't1' } } });
    expect(await canManageTeam(admin, 'mgr', 't1')).toBe(true);
  });

  it('manager does NOT manage a sibling team (false)', async () => {
    const admin = fakeAdmin({ users: { mgr: { role: 'manager', org_id: 'o1', team_id: 't1' } } });
    expect(await canManageTeam(admin, 'mgr', 't2')).toBe(false);
  });

  it('admin manages any team in its own org (true)', async () => {
    const admin = fakeAdmin({
      users: { adm: { role: 'admin', org_id: 'o1', team_id: null } },
      teams: { t9: { org_id: 'o1' } },
    });
    expect(await canManageTeam(admin, 'adm', 't9')).toBe(true);
  });

  it('admin does NOT manage a cross-org team (false)', async () => {
    const admin = fakeAdmin({
      users: { adm: { role: 'admin', org_id: 'o1', team_id: null } },
      teams: { t9: { org_id: 'o2' } },
    });
    expect(await canManageTeam(admin, 'adm', 't9')).toBe(false);
  });

  it('manager with NULL team_id manages no team (false)', async () => {
    const admin = fakeAdmin({ users: { mgr: { role: 'manager', org_id: 'o1', team_id: null } } });
    expect(await canManageTeam(admin, 'mgr', 't1')).toBe(false);
  });

  it('admin against a missing team manages nothing (false)', async () => {
    const admin = fakeAdmin({ users: { adm: { role: 'admin', org_id: 'o1', team_id: null } } });
    expect(await canManageTeam(admin, 'adm', 'ghost')).toBe(false);
  });

  it('a plain member manages no team (false)', async () => {
    const admin = fakeAdmin({ users: { me: { role: 'member', org_id: 'o1', team_id: 't1' } } });
    expect(await canManageTeam(admin, 'me', 't1')).toBe(false);
  });
});
