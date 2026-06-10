import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DeviceAuthStore, normalizePairingCode, type TokenCrypto } from './device-auth.js';

/**
 * A fake safeStorage: "encrypts" by base64 with a marker prefix and throws on
 * anything it didn't produce — mirroring safeStorage's corrupt-blob behavior.
 */
function fakeCrypto(available = true): TokenCrypto {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decrypt: (blob) => {
      const s = blob.toString();
      if (!s.startsWith('enc:')) throw new Error('corrupt blob');
      return Buffer.from(s.slice(4), 'base64').toString();
    },
  };
}

const META = {
  deviceId: '3b8a2f10-94d7-4d2e-8c61-5f0e9a7b1c22',
  userId: 'ef0a81f3-cc51-4642-9890-c28daa61fc8a',
  label: 'Work laptop',
  pairedAt: '2026-06-10T12:00:00.000Z',
  serverUrl: 'http://localhost:3000',
};

describe('DeviceAuthStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-device-auth-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('store -> fresh instance load restores token and metadata (the restart path)', () => {
    const first = new DeviceAuthStore(dir, fakeCrypto());
    first.store('the-secret-token', META);

    const second = new DeviceAuthStore(dir, fakeCrypto());
    second.load();
    expect(second.token).toBe('the-secret-token');
    expect(second.metadata).toEqual(META);
    expect(second.getPairState()).toEqual({
      paired: true,
      label: 'Work laptop',
      pairedAt: META.pairedAt,
    });
  });

  it('the token never appears on disk in plaintext', () => {
    new DeviceAuthStore(dir, fakeCrypto()).store('the-secret-token', META);
    for (const file of fs.readdirSync(dir)) {
      const contents = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(contents).not.toContain('the-secret-token');
    }
  });

  it('no files = not paired', () => {
    const store = new DeviceAuthStore(dir, fakeCrypto());
    store.load();
    expect(store.token).toBeNull();
    expect(store.getPairState()).toEqual({ paired: false });
  });

  it('a corrupt token blob wipes both files and reports not paired', () => {
    const first = new DeviceAuthStore(dir, fakeCrypto());
    first.store('the-secret-token', META);
    fs.writeFileSync(path.join(dir, 'device-token.bin'), 'garbage');

    const second = new DeviceAuthStore(dir, fakeCrypto());
    second.load();
    expect(second.getPairState()).toEqual({ paired: false });
    expect(fs.existsSync(path.join(dir, 'device-token.bin'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'device.json'))).toBe(false);
  });

  it('a token without metadata (partial state) is wiped, not half-restored', () => {
    const first = new DeviceAuthStore(dir, fakeCrypto());
    first.store('the-secret-token', META);
    fs.rmSync(path.join(dir, 'device.json'));

    const second = new DeviceAuthStore(dir, fakeCrypto());
    second.load();
    expect(second.token).toBeNull();
    expect(fs.existsSync(path.join(dir, 'device-token.bin'))).toBe(false);
  });

  it('malformed metadata is wiped too', () => {
    const first = new DeviceAuthStore(dir, fakeCrypto());
    first.store('the-secret-token', META);
    fs.writeFileSync(path.join(dir, 'device.json'), JSON.stringify({ label: 42 }));

    const second = new DeviceAuthStore(dir, fakeCrypto());
    second.load();
    expect(second.getPairState()).toEqual({ paired: false });
  });

  it('wipe (unpair / 401) clears memory and disk', () => {
    const store = new DeviceAuthStore(dir, fakeCrypto());
    store.store('the-secret-token', META);
    store.wipe();
    expect(store.token).toBeNull();
    expect(store.getPairState()).toEqual({ paired: false });
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('refuses to store when encryption is unavailable — no plaintext fallback', () => {
    const store = new DeviceAuthStore(dir, fakeCrypto(false));
    expect(() => store.store('the-secret-token', META)).toThrow(/encryption unavailable/i);
    expect(fs.readdirSync(dir)).toHaveLength(0); // nothing was written
  });

  it('getPairState never exposes the token', () => {
    const store = new DeviceAuthStore(dir, fakeCrypto());
    store.store('the-secret-token', META);
    expect(JSON.stringify(store.getPairState())).not.toContain('the-secret-token');
  });
});

describe('normalizePairingCode', () => {
  it('uppercases and strips whitespace, matching the server', () => {
    expect(normalizePairingCode(' ab2c d3ef\t')).toBe('AB2CD3EF');
    expect(normalizePairingCode('AB2CD3EF')).toBe('AB2CD3EF');
  });
});
