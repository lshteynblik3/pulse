import { describe, it, expect } from 'vitest';
import { buildCustomId, parseCustomId } from './custom-id';

describe('custom_id round-trip (collect attribution depends on this)', () => {
  const cases: { userId: string; date: string }[] = [
    { userId: 'e4f82d82-1c3a-4b5e-9f01-2a3b4c5d6e7f', date: '2026-06-15' }, // typical UUID
    { userId: '00000000-0000-0000-0000-000000000001', date: '2026-01-01' }, // year boundary
    { userId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', date: '2026-12-31' }, // year end
    { userId: 'deadbeef-0000-0000-0000-000000000000', date: '2024-02-29' }, // leap day
    { userId: 'brand-new-user-1234-5678-9abc-def012', date: '2026-06-18' }, // brand-new user
  ];

  it('recovers the ORIGINAL userId and date in the direction collect uses (parse∘build)', () => {
    for (const { userId, date } of cases) {
      expect(parseCustomId(buildCustomId(userId, date))).toEqual({ userId, date });
    }
  });

  it('recovers correctly even if a userId itself contains the separator (splits on the LAST __)', () => {
    const userId = 'weird__user__id';
    const date = '2026-06-15';
    expect(parseCustomId(buildCustomId(userId, date))).toEqual({ userId, date });
  });

  it('returns null for a malformed custom_id (no separator, non-date tail, or empty userId)', () => {
    expect(parseCustomId('no-separator-here')).toBeNull();
    expect(parseCustomId('user__not-a-date')).toBeNull();
    expect(parseCustomId('user__2026-6-1')).toBeNull(); // not zero-padded
    expect(parseCustomId('__2026-06-15')).toBeNull(); // empty userId
    expect(parseCustomId('')).toBeNull();
  });
});
