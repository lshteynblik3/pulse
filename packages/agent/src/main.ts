import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import * as path from 'node:path';
import type { ActivityEvent } from '@pulse/shared';

// ---------------------------------------------------------------------------
// Config — easy to find at the top.
// ---------------------------------------------------------------------------

/** Where batches of ActivityEvents are sent. Phase 1 talks to the local web app. */
const INGEST_URL = 'http://localhost:3000/api/ingest';

/** How often we sample the focused app. */
const POLL_INTERVAL_MS = 5_000;

/** How often the buffered events are POSTed to the backend. */
const FLUSH_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Events captured but not yet successfully sent. */
let buffer: ActivityEvent[] = [];
/** Timestamp of the previous poll, used as the start of the next interval. */
let lastPollAt: number | null = null;
/** Name of the app currently focused (for the tray window). */
let currentApp = '(none)';

// ---------------------------------------------------------------------------
// active-win is ESM-only, so load it via a dynamic import from this CJS module.
// ---------------------------------------------------------------------------

type ActiveWindowResult = { owner?: { name?: string } } | undefined;
type ActiveWindowFn = () => Promise<ActiveWindowResult>;
let activeWindowFn: ActiveWindowFn | null = null;

async function getActiveWindowFn(): Promise<ActiveWindowFn> {
  if (activeWindowFn) return activeWindowFn;
  const mod = (await import('active-win')) as {
    activeWindow?: ActiveWindowFn;
    default?: ActiveWindowFn;
  };
  const fn = mod.activeWindow ?? mod.default;
  if (!fn) throw new Error('active-win: could not resolve the activeWindow function');
  activeWindowFn = fn;
  return fn;
}

// ---------------------------------------------------------------------------
// Tracking.
// ---------------------------------------------------------------------------

async function poll(): Promise<void> {
  let name = currentApp;
  try {
    const activeWindow = await getActiveWindowFn();
    const result = await activeWindow();
    // PRIVACY: read the application NAME only. We deliberately never touch
    // result.title, result.url, or any other field (CLAUDE.md hard rule #1).
    name = result?.owner?.name?.trim() || '(unknown)';
  } catch (err) {
    console.error('active-win failed:', err);
    return;
  }

  const now = Date.now();
  if (lastPollAt !== null) {
    // Attribute the elapsed interval to the app we just observed. No
    // categorization or idle detection yet — that arrives in Phase 2.
    const event: ActivityEvent = {
      appName: name,
      category: 'other',
      startedAt: new Date(lastPollAt).toISOString(),
      endedAt: new Date(now).toISOString(),
      idle: false,
    };
    buffer.push(event);
  }
  lastPollAt = now;
  currentApp = name;
  win?.webContents.send('tracked-app', name);
}

async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`ingest responded ${res.status}`);
    console.log(`Sent ${batch.length} event(s) to ${INGEST_URL}`);
  } catch (err) {
    // Keep the events and retry on the next cycle (e.g. web app not running yet).
    console.error('Failed to send batch, will retry next cycle:', err);
    buffer = batch.concat(buffer);
  }
}

// ---------------------------------------------------------------------------
// UI: tray + tiny status window.
// ---------------------------------------------------------------------------

function makeTrayIcon(): Electron.NativeImage {
  // A simple 16x16 solid square so we don't ship a binary asset. Bytes are
  // BGRA per the platform bitmap format.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = 0xe5; // B
    buf[i * 4 + 1] = 0x4f; // G
    buf[i * 4 + 2] = 0x6d; // R
    buf[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 320,
    height: 170,
    resizable: false,
    title: 'Pulse',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('tracked-app', currentApp);
  });
  win.on('closed', () => {
    win = null;
  });
}

function showWindow(): void {
  if (!win) createWindow();
  else win.show();
}

function createTray(): void {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Pulse — tracking focus');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Pulse', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => {
    if (win?.isVisible()) win.hide();
    else showWindow();
  });
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

void app.whenReady().then(() => {
  createTray();
  createWindow();
  void poll(); // prime lastPollAt immediately
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
});

// Stay alive in the tray when the window is closed.
app.on('window-all-closed', () => {
  /* intentionally do nothing — this is a tray app */
});

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (flushTimer) clearInterval(flushTimer);
});
