import { requireUser } from '@/lib/auth/server';
import DevicesClient from './devices-client';

/**
 * /settings/devices — pair new agents, see and revoke existing ones.
 *
 * Server component shell: requireUser() (plus the middleware on /settings/*)
 * gates the page; everything interactive lives in the client component, which
 * talks to /api/devices*. The pairing code is only ever rendered here, in the
 * authenticated page body — it never appears in a URL, so it can't be linked,
 * shared, or end up in browser history.
 */
export default async function DevicesPage() {
  await requireUser();

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 560 }}>
      <h1>Devices</h1>
      <p style={{ color: '#555' }}>
        Each device runs the Pulse agent and sends only your aggregated daily summary,
        tied to your account by a token that never leaves that machine unencrypted.
      </p>
      <DevicesClient />
    </main>
  );
}
