'use client';

import { useEffect, useState } from 'react';
import styles from './settings.module.css';

type Account = { email: string; displayName: string | null };

/**
 * Account section: email read-only (it's the auth identity — the future auth
 * phase owns changing it), display name editable. Deliberately knows nothing
 * about HOW the user signed in: it just reads/writes /api/account, so a later
 * auth phase only has to pre-fill the name, not rework this.
 */
export default function AccountClient() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/account')
      .then(async (res) => {
        if (!res.ok) throw new Error(`account responded ${res.status}`);
        return (await res.json()) as Account;
      })
      .then((account) => {
        if (cancelled) return;
        setEmail(account.email);
        setName(account.displayName ?? '');
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your account.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // An emptied field clears the name (null) — everything then falls back
        // to email, including the agent's tray line.
        body: JSON.stringify({ displayName: name.trim() === '' ? null : name.trim() }),
      });
      const data = (await res.json()) as Account & { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Could not save your name.');
        return;
      }
      setName(data.displayName ?? '');
      setSavedAt(Date.now());
    } catch {
      setError('Could not save your name.');
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return <p className={styles.muted}>{error ?? 'Loading…'}</p>;
  }

  return (
    <div>
      <label className={styles.fieldLabel} htmlFor="account-email">
        Email
      </label>
      <input id="account-email" className={styles.textInput} value={email} readOnly />
      <p className={styles.hint}>How you sign in. Changing it arrives with a later auth update.</p>

      <label className={styles.fieldLabel} htmlFor="account-name">
        Name
      </label>
      <input
        id="account-name"
        className={styles.textInput}
        value={name}
        maxLength={80}
        placeholder="How should Pulse refer to you?"
        onChange={(e) => {
          setName(e.target.value);
          setSavedAt(null);
        }}
      />
      <p className={styles.hint}>
        Shown in the agent&apos;s tray menu. Leave blank to use your email instead.
      </p>

      <div className={styles.saveRow}>
        <button className={styles.primaryBtn} onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save name'}
        </button>
        {savedAt !== null && <span className={styles.savedNote}>Saved ✓</span>}
      </div>
      {error && <p className={styles.errorNote}>{error}</p>}
    </div>
  );
}
