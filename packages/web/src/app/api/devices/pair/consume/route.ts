import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
  generateDeviceToken,
  hashDeviceToken,
  isWellFormedPairingCode,
  normalizePairingCode,
} from '@/lib/devices/pairing';

/**
 * POST /api/devices/pair/consume — the agent trades a pairing code for a
 * device token. PUBLIC route: the agent has no session yet, which is the whole
 * point of pairing.
 *
 * Service-role use #1 of 2 (see also /api/ingest): the claim UPDATE and the
 * device_tokens INSERT below bypass RLS because there is no authenticated user
 * to scope them to — the pairing code itself is the proof of authorization.
 *
 * The plaintext token in the success response is the ONLY time it ever leaves
 * the server. It is not logged, and only its sha256 is stored — losing it means
 * pairing again.
 */

const bodySchema = z.object({
  code: z.string().min(1).max(64),
  deviceLabel: z.string().min(1).max(80),
});

/** Every failure is the same generic 400 — no oracle about why. */
function invalidCode(): NextResponse {
  return NextResponse.json(
    { error: 'invalid or expired code', code: 'INVALID_OR_EXPIRED_CODE' },
    { status: 400 },
  );
}

type FailureOutcome = 'malformed' | 'unknown_code' | 'expired' | 'already_consumed';

/**
 * Failed attempts are the brute-force signal to watch before any public deploy
 * (real rate limiting is deliberately deferred). The attempted code value is
 * NEVER logged: even wrong guesses are often near-misses or copy-paste slips of
 * a real user's live code, and logs get read by humans.
 */
function logFailedAttempt(request: Request, outcome: FailureOutcome): void {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  console.warn(
    JSON.stringify({ evt: 'pair_consume_failed', outcome, ip, at: new Date().toISOString() }),
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logFailedAttempt(request, 'malformed');
    return NextResponse.json({ error: 'Body must be valid JSON.' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    logFailedAttempt(request, 'malformed');
    return NextResponse.json({ error: 'Expected { code, deviceLabel }.' }, { status: 400 });
  }

  // Same normalization the agent applies — the two can never disagree.
  const code = normalizePairingCode(parsed.data.code);
  const deviceLabel = parsed.data.deviceLabel.trim();
  if (!isWellFormedPairingCode(code) || deviceLabel.length === 0) {
    logFailedAttempt(request, 'malformed');
    return invalidCode();
  }

  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  // The atomic claim: one conditional UPDATE. Postgres row locking guarantees
  // that two agents racing on the same code produce exactly one winner — the
  // loser's UPDATE matches zero rows and falls through to the generic 400.
  const { data: claimed, error: claimError } = await admin
    .from('pairing_codes')
    .update({ consumed_at: nowIso, device_label: deviceLabel })
    .eq('code', code)
    .is('consumed_at', null)
    .gt('expires_at', nowIso)
    .select('user_id');

  if (claimError) {
    return NextResponse.json({ error: 'Pairing failed.' }, { status: 500 });
  }

  const claimedRow = claimed?.[0];
  if (!claimedRow) {
    // Classify the failure for the log line only — the response stays generic.
    const { data: existing } = await admin
      .from('pairing_codes')
      .select('consumed_at, expires_at')
      .eq('code', code)
      .maybeSingle();
    const outcome: FailureOutcome = !existing
      ? 'unknown_code'
      : existing.consumed_at !== null
        ? 'already_consumed'
        : 'expired';
    logFailedAttempt(request, outcome);
    return invalidCode();
  }

  const userId = claimedRow.user_id as string;

  const token = generateDeviceToken();
  const { data: inserted, error: insertError } = await admin
    .from('device_tokens')
    .insert({ user_id: userId, token_hash: hashDeviceToken(token), device_label: deviceLabel })
    .select('id')
    .single();

  if (insertError || !inserted) {
    // The code was already claimed above, so it's burned with no token issued.
    // That's the accepted tradeoff for keeping consume to two plain statements —
    // the failure is harmless and self-evident: the user issues a fresh code.
    return NextResponse.json(
      { error: 'Pairing failed — please issue a new code and try again.' },
      { status: 500 },
    );
  }

  // deviceId is this device's own device_tokens row id — not sensitive, and the
  // natural handle if the agent ever needs to ask the server about itself later.
  return NextResponse.json(
    { token, deviceId: inserted.id as string, userId, deviceLabel },
    { status: 200 },
  );
}
