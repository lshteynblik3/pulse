export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>Pulse</h1>
      <p>Phase 1 slice. API routes:</p>
      <ul>
        <li>
          <code>POST /api/ingest</code> — accepts an ActivityEvent[] and stores raw events
        </li>
        <li>
          <code>GET /api/summary/today</code> — total minutes per app for today
        </li>
      </ul>
    </main>
  );
}
