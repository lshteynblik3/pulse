import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Local storage for the device's pairing credential.
 *
 * The bearer token is the agent's identity from Phase 4b on. It exists in
 * exactly two places on this machine: process memory, and the encrypted blob
 * `device-token.bin` under userData. It is NEVER written to disk in plaintext —
 * if encryption is unavailable, pairing is refused outright (no fallback).
 *
 * `device.json` next to it holds only non-secret metadata for the panel.
 *
 * The encryption backend (Electron's safeStorage in production) is injected so
 * this module is unit-testable in plain Node.
 */

export interface TokenCrypto {
  /** safeStorage.isEncryptionAvailable — false on e.g. Linux without libsecret. */
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  /** Must throw on a corrupt/foreign blob (safeStorage does). */
  decrypt(blob: Buffer): string;
}

/** Non-secret pairing metadata, persisted as plain JSON. */
export interface DeviceMetadata {
  /** This device's own device_tokens row id (from the consume response). */
  deviceId: string;
  /** The account this device is bound to (from the consume response). */
  userId: string;
  label: string;
  pairedAt: string; // ISO
  /** The server the token was issued by — the ONLY host it is ever sent to. */
  serverUrl: string;
}

/** What the Transparency panel sees. Never includes the token. */
export interface PairState {
  paired: boolean;
  label?: string;
  pairedAt?: string;
}

const TOKEN_FILE = 'device-token.bin';
const METADATA_FILE = 'device.json';

function isDeviceMetadata(value: unknown): value is DeviceMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<DeviceMetadata>;
  return (
    typeof v.deviceId === 'string' &&
    v.deviceId.length > 0 &&
    typeof v.userId === 'string' &&
    v.userId.length > 0 &&
    typeof v.label === 'string' &&
    v.label.length > 0 &&
    typeof v.pairedAt === 'string' &&
    typeof v.serverUrl === 'string' &&
    v.serverUrl.length > 0
  );
}

export class DeviceAuthStore {
  private readonly tokenPath: string;
  private readonly metadataPath: string;
  private readonly crypto: TokenCrypto;

  private tokenInMemory: string | null = null;
  private meta: DeviceMetadata | null = null;

  constructor(dir: string, crypto: TokenCrypto) {
    this.tokenPath = path.join(dir, TOKEN_FILE);
    this.metadataPath = path.join(dir, METADATA_FILE);
    this.crypto = crypto;
  }

  /**
   * Restore the credential on startup. Both files must exist, parse, and
   * decrypt — any partial or corrupt state is wiped and treated as "not
   * paired" (the user pairs again; tokens are never recoverable by design).
   */
  load(): void {
    let token: string;
    let meta: unknown;
    try {
      const blob = fs.readFileSync(this.tokenPath);
      token = this.crypto.decrypt(blob);
      meta = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8'));
    } catch {
      this.wipe();
      return;
    }
    if (token.length === 0 || !isDeviceMetadata(meta)) {
      this.wipe();
      return;
    }
    this.tokenInMemory = token;
    this.meta = meta;
  }

  /** The bearer token, or null when not paired. Memory only — never logged. */
  get token(): string | null {
    return this.tokenInMemory;
  }

  get metadata(): DeviceMetadata | null {
    return this.meta;
  }

  /** Panel-safe view of the pairing state. */
  getPairState(): PairState {
    if (!this.meta || !this.tokenInMemory) return { paired: false };
    return { paired: true, label: this.meta.label, pairedAt: this.meta.pairedAt };
  }

  /**
   * Persist a fresh credential after a successful pair/consume. Throws if
   * encryption is unavailable — callers must check beforehand and refuse to
   * pair, because a plaintext fallback is forbidden.
   */
  store(token: string, meta: DeviceMetadata): void {
    if (!this.crypto.isAvailable()) {
      throw new Error('OS-level encryption unavailable — refusing to store the device token.');
    }
    fs.writeFileSync(this.tokenPath, this.crypto.encrypt(token));
    fs.writeFileSync(this.metadataPath, JSON.stringify(meta, null, 2));
    this.tokenInMemory = token;
    this.meta = meta;
  }

  /**
   * Remove the credential locally (unpair, or a 401 told us it was revoked).
   * Does not call the server: revocation is a web-side action.
   */
  wipe(): void {
    this.tokenInMemory = null;
    this.meta = null;
    for (const file of [this.tokenPath, this.metadataPath]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Best-effort: a locked file shouldn't crash the agent; memory is clear.
      }
    }
  }
}

/**
 * Same normalization the server applies before lookup, so a copy-pasted code
 * with stray spaces or lowercase still pairs.
 */
export function normalizePairingCode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}
