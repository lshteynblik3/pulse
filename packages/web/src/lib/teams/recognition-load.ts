import type { SupabaseClient } from '@supabase/supabase-js';
import type { DailySummary } from '@pulse/shared';
import { fetchWindowStart } from '../dashboard/compute';
import { getWorkSchedule } from '../work-schedule/loader';
import { detectTeamRecognition, type RecognitionEvent, type RecognitionMember } from './recognition';

/**
 * The I/O boundary for recognition: fetch a managed team's members (EXCLUDING the
 * viewing manager) + each member's scoring window + schedule, then run the PURE
 * detector. Shared by BOTH the GET (read → cards) and the POST /ack (re-derive →
 * notify), so the two re-derive identically — the POST can't be tricked into
 * notifying a key the GET wouldn't have shown.
 *
 * Service-role reads, pinned to a team the caller has ALREADY authorized via
 * canManageTeam (this helper does not authorize — the route must gate first).
 *
 * COST (debt (c) × team size): this re-runs the per-member 122-day scoring fetch,
 * and /team calls both the aggregate endpoint and this one, so the per-member
 * fetch happens twice per /team load. Acceptable for small teams; a shared single
 * fetch is a deferred optimization, written as debt, not solved here.
 */

interface DailySummaryRow {
  user_id: string;
  date: string;
  active_minutes: number;
  focus_minutes: number;
  meeting_minutes: number;
  category_breakdown: DailySummary['categoryBreakdown'];
  focus_block_count: number;
  focus_block_minutes: number;
  hourly_focus_minutes: number[];
  tasks_completed: number;
  agent_version: string;
}

function rowToSummary(row: DailySummaryRow): DailySummary {
  return {
    userId: row.user_id,
    date: row.date,
    activeMinutes: row.active_minutes,
    focusMinutes: row.focus_minutes,
    meetingMinutes: row.meeting_minutes,
    categoryBreakdown: row.category_breakdown,
    focusBlockCount: row.focus_block_count,
    focusBlockMinutes: row.focus_block_minutes,
    hourlyFocusMinutes: row.hourly_focus_minutes,
    tasksCompleted: row.tasks_completed,
    agentVersion: row.agent_version,
  };
}

/** display_name, falling back to the email's local-part — the manager card's label. */
function memberName(displayName: string | null, email: string): string {
  return displayName ?? email.split('@')[0] ?? email;
}

/**
 * Detect the current recognition events for `teamId` as of `date`. Excludes
 * `managerId` (managers see their own wins on their own dashboard). Throws on a DB
 * error so the route turns it into a 500 (absence ≠ failure).
 */
export async function loadTeamRecognitionEvents(
  admin: SupabaseClient,
  teamId: string,
  managerId: string,
  date: string,
): Promise<RecognitionEvent[]> {
  const { data: roster, error: rosterError } = await admin
    .from('users')
    .select('id, display_name, email')
    .eq('team_id', teamId)
    .neq('id', managerId); // recognition is about the OTHER members, not the viewer
  if (rosterError) {
    throw new Error(`Could not load the team roster: ${rosterError.message}`);
  }

  const windowStart = fetchWindowStart(date);
  const members: RecognitionMember[] = [];
  for (const row of roster ?? []) {
    const id = row.id as string;
    const { data: sumRows, error: sumError } = await admin
      .from('daily_summaries')
      .select('*')
      .eq('user_id', id)
      .gte('date', windowStart)
      .lte('date', date)
      .order('date', { ascending: true });
    if (sumError) {
      throw new Error(`Could not load member summaries: ${sumError.message}`);
    }
    const { schedule } = await getWorkSchedule(admin, id);
    members.push({
      recipientId: id,
      name: memberName((row.display_name as string | null) ?? null, row.email as string),
      summaries: ((sumRows ?? []) as DailySummaryRow[]).map(rowToSummary),
      schedule,
    });
  }

  return detectTeamRecognition(members, date);
}
