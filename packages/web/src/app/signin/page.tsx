'use client';

import { useState } from 'react';
import { createClient } from '@/lib/auth/client';

type State =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'sent' }
  | { status: 'error'; message: string };

export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState({ status: 'sending' });

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // Where the magic link sends the user back. This exact URL must be in
        // Supabase → Auth → URL Configuration → Redirect URLs.
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setState({ status: 'error', message: error.message });
    } else {
      setState({ status: 'sent' });
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 420 }}>
      <h1>Sign in to Pulse</h1>

      {state.status === 'sent' ? (
        <p>
          Check your email. We sent a magic link to <strong>{email}</strong> — click it
          to finish signing in. You can close this tab.
        </p>
      ) : (
        <form onSubmit={onSubmit}>
          <p style={{ color: '#555' }}>
            Enter your email and we&apos;ll send you a one-time magic link. No password.
          </p>
          <label htmlFor="email" style={{ display: 'block', marginBottom: 4 }}>
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            style={{ width: '100%', padding: 8, fontSize: 16, boxSizing: 'border-box' }}
          />
          <button
            type="submit"
            disabled={state.status === 'sending'}
            style={{ marginTop: 12, padding: '8px 16px', fontSize: 16, cursor: 'pointer' }}
          >
            {state.status === 'sending' ? 'Sending…' : 'Send magic link'}
          </button>
          {state.status === 'error' && (
            <p style={{ color: '#b00020', marginTop: 12 }}>
              Could not send the link: {state.message}
            </p>
          )}
        </form>
      )}
    </main>
  );
}
