import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabaseAdmin } from '@/lib/supabase';
import { collectBatchResults, decideBatchAction, type RawBatchResult } from '@/lib/insights/collect-parse';

/**
 * GET /api/cron/insights/collect — the COLLECT half of the Phase 5 insights
 * worker. Scans outstanding batches (status = 'submitted'); for each:
 *  - retrieve it from Anthropic and decide (decideBatchAction):
 *      'wait'    -> not done, still within 24h: leave the row, retry next run.
 *      'expire'  -> not done, past 24h: mark 'expired' (terminal), stop scanning;
 *                   those users fall through to computed tips at read.
 *      'collect' -> ended: parse + store.
 *  - on collect, for each result: strip ```fences UNCONDITIONALLY -> JSON.parse
 *    -> validate against the frozen schema. Per-user failure (transport / bad
 *    custom_id / parse / schema) is SKIPPED + logged (custom_id only, never
 *    content); it never aborts the batch.
 *  - store is idempotent: delete-then-insert per (user_id, date), so re-running
 *    changes nothing. The date is the user's LOCAL date from the custom_id.
 *
 * Safe to run repeatedly. Service-role throughout; CRON_SECRET-protected.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface BatchRow {
  id: string;
  batch_id: string;
  submitted_at: string;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured.' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  const { data: rows, error } = await admin
    .from('insight_batches')
    .select('id, batch_id, submitted_at')
    .eq('status', 'submitted');
  if (error) {
    return NextResponse.json({ error: 'Could not load outstanding batches.' }, { status: 500 });
  }

  const outstanding = (rows ?? []) as BatchRow[];
  if (outstanding.length === 0) {
    return NextResponse.json({ collected: 0, expired: 0, waiting: 0, stored: 0, skipped: 0 });
  }

  const anthropic = new Anthropic();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  let collected = 0;
  let expired = 0;
  let waiting = 0;
  let stored = 0;
  let skipped = 0;

  for (const row of outstanding) {
    try {
      const batch = await anthropic.messages.batches.retrieve(row.batch_id);
      const ageMs = now - Date.parse(row.submitted_at);
      const action = decideBatchAction(batch.processing_status, ageMs);

      if (action === 'wait') {
        waiting++;
        continue;
      }

      if (action === 'expire') {
        await admin
          .from('insight_batches')
          .update({ status: 'expired', collected_at: nowIso })
          .eq('id', row.id);
        expired++;
        continue;
      }

      // action === 'collect' — batch ended; gather its results, preserving each
      // request's OWN terminal status (succeeded/errored/canceled/expired) so the
      // pure collector decides per-request, not this route.
      const raw: RawBatchResult[] = [];
      for await (const entry of await anthropic.messages.batches.results(row.batch_id)) {
        if (entry.result.type === 'succeeded') {
          const text = entry.result.message.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');
          raw.push({ customId: entry.custom_id, status: 'succeeded', text });
        } else {
          // entry.result.type is 'errored' | 'canceled' | 'expired' here.
          raw.push({ customId: entry.custom_id, status: entry.result.type, text: null });
        }
      }

      const { stored: toStore, skipped: toSkip } = collectBatchResults(raw);
      for (const s of toSkip) {
        // custom_id (userId + date) only — never any insight content.
        console.warn(`[insights collect] skipped ${s.customId}: ${s.reason}`);
      }
      skipped += toSkip.length;

      for (const s of toStore) {
        // Idempotent per (user_id, date): wipe this day's insights, then re-insert.
        await admin.from('insights').delete().eq('user_id', s.userId).eq('date', s.date);
        const { error: insErr } = await admin.from('insights').insert(
          s.insights.map((i) => ({
            user_id: s.userId,
            date: s.date,
            type: i.type,
            title: i.title,
            body: i.body,
          })),
        );
        if (insErr) {
          console.warn(`[insights collect] insert failed for ${s.userId}__${s.date}: ${insErr.message}`);
          continue;
        }
        stored++;
      }

      await admin
        .from('insight_batches')
        .update({ status: 'collected', collected_at: nowIso })
        .eq('id', row.id);
      collected++;
    } catch (err) {
      // Transient failure on THIS batch (e.g. an Anthropic retrieve/network error):
      // leave the row 'submitted' so the next collect run retries it. Don't abort
      // the loop — other batches still process.
      console.warn(
        `[insights collect] batch ${row.batch_id} errored, will retry next run: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return NextResponse.json({ collected, expired, waiting, stored, skipped });
}
