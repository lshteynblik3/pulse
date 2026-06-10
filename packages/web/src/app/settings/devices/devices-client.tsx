'use client';

import { useCallback, useEffect, useState } from 'react';

type Device = {
  id: string;
  deviceLabel: string;
  lastUsedAt: string | null;
  createdAt: string;
  revoked: boolean;
};

type IssuedCode = { code: string; expiresAt: string };

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString();
}

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
    <section>
      <h2 style={{ fontSize: 16 }}>Pair a new device</h2>
      {issued ? (
        <div style={{ border: '1px solid #ccc', borderRadius: 6, padding: 16, marginBottom: 8 }}>
          <div
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 36,
              letterSpacing: '0.18em',
              fontWeight: 700,
            }}
          >
            {issued.code}
            <button
              onClick={() => void copyCode()}
              style={{ marginLeft: 12, fontSize: 14, padding: '4px 12px', cursor: 'pointer', verticalAlign: 'middle' }}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
          <div style={{ color: '#555', marginTop: 8 }}>
            Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}.
            Paste this in your Pulse app&apos;s pairing screen.
          </div>
        </div>
      ) : (
        <button
          onClick={() => void issueCode()}
          disabled={issuing}
          style={{ padding: '8px 16px', fontSize: 16, cursor: 'pointer' }}
        >
          {issuing ? 'Issuing…' : 'Pair a new device'}
        </button>
      )}

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Your devices</h2>
      {devices === null ? (
        <p style={{ color: '#555' }}>Loading…</p>
      ) : devices.length === 0 ? (
        <p style={{ color: '#555' }}>No devices paired yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#666' }}>
              <th style={{ padding: '6px 8px' }}>Device</th>
              <th style={{ padding: '6px 8px' }}>Last used</th>
              <th style={{ padding: '6px 8px' }} />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: '6px 8px' }}>
                  {d.deviceLabel}
                  {d.revoked && <span style={{ color: '#b00020' }}> (revoked)</span>}
                </td>
                <td style={{ padding: '6px 8px', color: '#555' }}>{formatWhen(d.lastUsedAt)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                  {!d.revoked && (
                    <button onClick={() => void revoke(d)} style={{ cursor: 'pointer' }}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
    </section>
  );
}
