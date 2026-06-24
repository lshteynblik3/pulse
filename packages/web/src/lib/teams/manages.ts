import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The "manages" relationship — Phase 6's AUTHORIZATION SPINE.
 *
 * Single source of truth for the question "does actor M manage user U / team T?".
 * Every manager read must route through this; nothing else gets to make that
 * judgment. Built + unit-tested here, consumed by NO endpoint yet (same
 * "built, not yet wired" pattern as previousWorkingDay). When the first endpoint
 * calls these, its admin-client reads of OTHER users'/teams' rows become
 * enumerated service-role entry #9 in CLAUDE.md.
 *
 * Reads run on the ADMIN (service-role) client by design: the actor's session
 * client can only read its OWN users row under RLS, but answering "do I manage
 * this OTHER user" requires reading the target's team_id / org_id. The functions
 * return only a boolean — never row data leaks out.
 *
 * Role-specific non-null gate (the subtle rule): a 'manager' is scoped to ONE
 * team, so it requires a non-null team_id. An 'admin' is org-wide and may belong
 * to no single team, so it requires a non-null org_id and team_id is IRRELEVANT —
 * gating an admin on team_id would wrongly lock out a teamless org admin.
 */

interface ActorRow {
  role: string | null;
  org_id: string | null;
  team_id: string | null;
}

async function loadUser(
  admin: SupabaseClient,
  userId: string,
): Promise<ActorRow | null> {
  const { data, error } = await admin
    .from('users')
    .select('role, org_id, team_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not load user for authorization: ${error.message}`);
  }
  return (data as ActorRow | null) ?? null;
}

async function loadTeamOrgId(
  admin: SupabaseClient,
  teamId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('teams')
    .select('org_id')
    .eq('id', teamId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not load team for authorization: ${error.message}`);
  }
  return (data as { org_id: string | null } | null)?.org_id ?? null;
}

/**
 * Does `actorId` manage `targetUserId`?
 *
 * - 'manager': iff the target is on the actor's own (non-null) team.
 * - 'admin'  : iff the target is in the actor's own (non-null) org — never
 *              cross-org.
 * - anyone else, or an actor failing its role's non-null gate: false.
 *
 * Reads the TARGET user's row via the admin client — the helper's only read of a
 * users row other than the caller's.
 */
export async function canManageUser(
  admin: SupabaseClient,
  actorId: string,
  targetUserId: string,
): Promise<boolean> {
  const actor = await loadUser(admin, actorId);
  if (!actor) return false;

  if (actor.role === 'manager') {
    if (!actor.team_id) return false; // manager with no team manages nobody
    const target = await loadUser(admin, targetUserId);
    if (!target) return false;
    return target.team_id === actor.team_id;
  }

  if (actor.role === 'admin') {
    if (!actor.org_id) return false; // admin gates on org, NOT team
    const target = await loadUser(admin, targetUserId);
    if (!target) return false;
    return target.org_id === actor.org_id; // org-bounded — never cross-org
  }

  return false; // member or unknown role
}

/**
 * Does `actorId` manage team `teamId`?
 *
 * - 'manager': iff `teamId` is the actor's own (non-null) team. No team read
 *              needed.
 * - 'admin'  : iff that team belongs to the actor's own (non-null) org — reads
 *              the target team's org_id via the admin client; never cross-org.
 * - anyone else, or an actor failing its role's non-null gate: false.
 */
export async function canManageTeam(
  admin: SupabaseClient,
  actorId: string,
  teamId: string,
): Promise<boolean> {
  const actor = await loadUser(admin, actorId);
  if (!actor) return false;

  if (actor.role === 'manager') {
    if (!actor.team_id) return false;
    return teamId === actor.team_id;
  }

  if (actor.role === 'admin') {
    if (!actor.org_id) return false;
    const teamOrgId = await loadTeamOrgId(admin, teamId);
    if (!teamOrgId) return false; // team missing → not manageable
    return teamOrgId === actor.org_id; // org-bounded — never cross-org
  }

  return false;
}
