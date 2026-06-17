import { describe, it, expect } from 'vitest';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  generatePairingCode,
  normalizePairingCode,
  isWellFormedPairingCode,
  generateDeviceToken,
  hashDeviceToken,
} from './pairing';

describe('pairing codes', () => {
  it('the alphabet has 31 chars and none of the ambiguous ones', () => {
    expect(PAIRING_CODE_ALPHABET).toHaveLength(31);
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) {
      expect(PAIRING_CODE_ALPHABET).not.toContain(ambiguous);
    }
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(31); // no duplicates
  });

  it('generated codes are 8 chars, all from the alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      expect(isWellFormedPairingCode(code)).toBe(true);
    }
  });

  it('normalization uppercases and strips all whitespace', () => {
    expect(normalizePairingCode('  ab2c d3ef\t')).toBe('AB2CD3EF');
    expect(normalizePairingCode('AB2C-D3EF')).toBe('AB2C-D3EF'); // only whitespace is stripped
  });

  it('well-formedness rejects wrong length and out-of-alphabet chars', () => {
    expect(isWellFormedPairingCode('AB2CD3EF')).toBe(true);
    expect(isWellFormedPairingCode('AB2CD3E')).toBe(false); // 7 chars
    expect(isWellFormedPairingCode('AB2CD3EF2')).toBe(false); // 9 chars
    expect(isWellFormedPairingCode('AB2CD3E0')).toBe(false); // 0 not in alphabet
    expect(isWellFormedPairingCode('ab2cd3ef')).toBe(false); // lowercase (normalize first)
    expect(isWellFormedPairingCode('XYZ12345')).toBe(false); // 1 not in alphabet
  });
});

describe('device tokens', () => {
  it('is 43 chars of unpadded base64url (32 bytes of entropy)', () => {
    const token = generateDeviceToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // no +, /, or = padding
  });

  it('two tokens are never the same', () => {
    expect(generateDeviceToken()).not.toBe(generateDeviceToken());
  });

  it('hashes to sha256 hex (known vector), stable across calls', () => {
    // echo -n "test-token" | sha256sum
    expect(hashDeviceToken('test-token')).toBe(
      '4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e',
    );
    const t = generateDeviceToken();
    expect(hashDeviceToken(t)).toBe(hashDeviceToken(t));
    expect(hashDeviceToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});
