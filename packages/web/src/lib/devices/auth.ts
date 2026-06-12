import { getSupabaseAdmin } from '@/lib/supabase';
import { hashDeviceToken } from './pairing';

/**
 * Device-token authentication (Phase 4b) — THE one mechanism that turns an
 * agent's `Authorization: Bearer <token>` header into a user identity. The
 * agent sends the plaintext token; we look up sha256(token) in device_tokens.
 *
 * This lookup runs on the service-role client and must: the agent has no
 * Supabase session — the token itself is the credential being verified.
 * Service-role usage stays limited to pair/consume plus this helper; its
 * callers are enumerated here so the surface stays auditable:
 *   - POST /api/ingest  (summary upsert for the token's user)
 *   - GET  /api/me      (whoami: the token's own user's email/display name)
 *
 * Returns the device row's user_id, or null for anything that isn't a valid,
 * unrevoked token. A revoked token fails from the next request onward — the
 * agent treats an ingest 401 as "wipe local credentials and re-pair." The
 * token value is NEVER logged, here or in any caller.
 */
export interface AuthenticatedDevice {
  userId: string;
  deviceTokenId: string;
}

export async function authenticateDevice(request: Request): Promise<AuthenticatedDevice | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) return null;

  const { data, error } = await getSupabaseAdmin()
    .from('device_tokens')
    .select('id, user_id')
    .eq('token_hash', hashDeviceToken(token))
    .is('revoked_at', null)
    .maybeSingle();

  if (error || !data) return null;
  return { userId: data.user_id as string, deviceTokenId: data.id as string };
}
