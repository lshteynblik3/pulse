/**
 * Landing page. Deliberately spare until there's a real marketing page — but
 * what it says about data handling must match the actual contract: the agent
 * sends one aggregated daily summary, never raw activity.
 */
export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 560 }}>
      <h1>Pulse</h1>
      <p style={{ color: '#555' }}>
        Privacy-first productivity coaching. The Pulse agent measures your focus patterns
        locally, on your machine, and shares only a once-a-day summary — never keystrokes,
        screenshots, window titles, or browsing history.
      </p>
      <p>
        <a href="/dashboard">Open your dashboard →</a>
      </p>
    </main>
  );
}
