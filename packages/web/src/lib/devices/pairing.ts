import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * Pure helpers for device pairing: code + token generation and hashing.
 * No I/O, no Supabase — unit tested alongside in pairing.test.ts.
 *
 * Privacy/security floor (CLAUDE.md + the 4b spec):
 *   - The plaintext device token leaves the server exactly once, in the
 *     pair/consume response. The database stores only sha256(token).
 *   - Pairing-code values are never logged, even on failed attempts.
 */

/** Uppercase alphanumerics minus the ambiguous 0/O/1/I/L — 31 characters. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const PAIRING_CODE_LENGTH = 8;

/** A pairing code is consumable for 10 minutes after issue. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * 8 chars from the 31-char alphabet ≈ 8.5e11 possibilities. crypto.randomInt is
 * CSPRNG-backed and rejection-sampled internally, so there's no modulo bias.
 */
export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * The agent uppercases and strips whitespace before sending; the server applies
 * the same normalization so the two can never disagree about what was typed.
 */
export function normalizePairingCode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

/** True if a normalized code even *could* be one we issued (length + alphabet). */
export function isWellFormedPairingCode(code: string): boolean {
  if (code.length !== PAIRING_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!PAIRING_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** 32 random bytes, base64url without padding → a 43-char opaque bearer token. */
export function generateDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 hex — the ONLY form of the token that ever touches the database. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
