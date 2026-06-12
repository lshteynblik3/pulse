'use client';

import { useCallback, useEffect, useState } from 'react';
import { relativeTimeLabel } from '@/lib/dashboard/format';
import styles from './settings.module.css';

// /api/devices returns ACTIVE devices only (4g): revoked rows stay in the
// table as an audit trail but no longer clutter this list.
type Device = {
  id: string;
  deviceLabel: string;
  lastUsedAt: string | null;
  createdAt: string;
};

type IssuedCode = { code: string; expiresAt: string };

export default function DevicesClient() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [copied, setCopied] = useState(false);

  const loadDevices = useCallback(async () => {
    try {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error(`devices responded ${res.status}`);
      const data = (await res.json()) as { devices: Device[] };
      setDevices(data.devices);
      setError(null);
    } catch {
      setError('Could not load your devices.');
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  // Countdown to the issued code's expiry; the display clears itself at zero.
  useEffect(() => {
    if (!issued) return;
    const tick = () => {
      const left = Math.max(0, Math.round((new Date(issued.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setIssued(null);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [issued]);

  async function issueCode() {
    setIssuing(true);
    setCopied(false);
    try {
      const res = await fetch('/api/devices/pair/issue', { method: 'POST' });
      if (!res.ok) throw new Error(`issue responded ${res.status}`);
      setIssued((await res.json()) as IssuedCode);
      setError(null);
    } catch {
      setError('Could not issue a pairing code.');
    } finally {
      setIssuing(false);
    }
  }

  async function copyCode() {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.code);
    setCopied(true);
  }

  async function revoke(device: Device) {
    const sure = window.confirm(
      `Revoke "${device.deviceLabel}"? Its next send will be rejected and the agent will ask to be paired again.`,
    );
    if (!sure) return;
    const res = await fetch(`/api/devices/${device.id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      setError('Could not revoke that device.');
      return;
    }
    await loadDevices();
  }

  return (
    <div>
      <h3 className={styles.subTitle}>Pair a new device</h3>
      {issued ? (
        <div className={styles.pairCodeBox}>
          <span className={styles.pairCode}>{issued.code}</span>
          <button
            className={styles.quietBtn}
            style={{ marginLeft: 12, verticalAlign: 'middle' }}
            onClick={() => void copyCode()}
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <p className={styles.hint}>
            Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}.
            Paste this in your Pulse app&apos;s pairing screen.
          </p>
        </div>
      ) : (
        <button className={styles.primaryBtn} onClick={() => void issueCode()} disabled={issuing}>
          {issuing ? 'Issuing…' : 'Pair a new device'}
        </button>
      )}

      <h3 className={styles.subTitle}>Your devices</h3>
      {devices === null ? (
        <p className={styles.muted}>Loading…</p>
      ) : devices.length === 0 ? (
        <p className={styles.muted}>No devices paired yet.</p>
      ) : (
        <table className={styles.deviceTable}>
          <thead>
            <tr>
              <th>Device</th>
              <th>Last posted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.deviceLabel}</td>
                <td className={styles.deviceMeta}>
                  {d.lastUsedAt ? (
                    // Hover shows the exact local time; the cell stays human.
                    <span title={new Date(d.lastUsedAt).toLocaleString()}>
                      {relativeTimeLabel(d.lastUsedAt)}
                    </span>
                  ) : (
                    'never'
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button className={styles.quietBtn} onClick={() => void revoke(d)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <p className={styles.errorNote}>{error}</p>}
    </div>
  );
}
