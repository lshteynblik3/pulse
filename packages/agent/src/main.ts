import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  powerMonitor,
} from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Category } from '@pulse/shared';
import { DayAggregator } from './aggregator.js';
import { loadCategoryConfig, type CategoryConfig } from './config.js';
import { localDateString } from './time.js';

// ---------------------------------------------------------------------------
// Config — easy to find at the top.
// ---------------------------------------------------------------------------

/** The ONLY thing the agent sends: a DailySummary, every flush. */
const INGEST_URL = 'http://localhost:3000/api/ingest';

/** How often we sample the focused app + idle state. */
const POLL_INTERVAL_MS = 5_000;

/** How often the current DailySummary is upserted to the backend. */
const FLUSH_INTERVAL_MS = 15 * 60 * 1000;

/** No input for this many seconds = idle (SPEC: "no input > 3 min"). */
const IDLE_THRESHOLD_SECONDS = 180;

/** Stamped into every DailySummary. */
const AGENT_VERSION = '0.2.0';

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

let config: CategoryConfig;
let aggregator: DayAggregator;
let deviceId: string;

/** "Mark private": when true, the agent captures nothing at all. */
let paused = false;
/** Timestamp of the previous poll; null means "don't form a slice this poll". */
let lastPollAt: number | null = null;
/** Last non-idle app name, for display. */
let currentApp = '(none)';
let quitting = false;

// ---------------------------------------------------------------------------
// active-win is ESM-only: load it via dynamic import from this CJS module.
// We read the application NAME only — never titles/URLs (CLAUDE.md rule #1).
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
// Device identity.
//
// TEMPORARY (Phase 2): with no auth yet, we identify this machine by a UUID
// persisted in userData and reused forever. Phase 4 replaces this with the
// authenticated user's account id.
// ---------------------------------------------------------------------------

function loadOrCreateDeviceId(): string {
  const file = path.join(app.getPath('userData'), 'device-id.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { deviceId?: unknown };
    if (typeof parsed.deviceId === 'string' && parsed.deviceId.length > 0) {
      return parsed.deviceId;
    }
  } catch {
    // File doesn't exist yet — fall through and create it.
  }
  const id = randomUUID();
  fs.writeFileSync(file, JSON.stringify({ deviceId: id }, null, 2));
  return id;
}

function loadConfigOrDefault(): CategoryConfig {
  const file = path.join(__dirname, '../config/categories.json');
  try {
    return loadCategoryConfig(file);
  } catch (err) {
    console.error('Failed to load categories.json — every app will be "other":', err);
    return {
      productive: new Set<Category>(),
      categorize: () => 'other',
      isProductive: () => false,
    };
  }
}

// ---------------------------------------------------------------------------
// Tracking loop.
// ---------------------------------------------------------------------------

async function poll(): Promise<void> {
  const now = Date.now();
  const today = localDateString(new Date(now));

  // (2) Day rollover: flush the finished day, then start a fresh aggregator.
  if (today !== aggregator.date) {
    await flushSummary();
    aggregator = new DayAggregator(today);
    lastPollAt = null; // never form a slice spanning midnight
  }

  // (4) Paused = "mark private": capture nothing, close any open focus run.
  if (paused) {
    aggregator.interrupt();
    lastPollAt = null;
    updateStatus();
    return;
  }

  // (1) Idle detection. getSystemIdleTime() returns ONLY seconds-since-last-input
  // (a duration, never the input). A locked screen counts as idle too.
  const idleSeconds = powerMonitor.getSystemIdleTime();
  const locked = powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS) === 'locked';
  const idle = idleSeconds >= IDLE_THRESHOLD_SECONDS || locked;

  let appName = currentApp;
  if (!idle) {
    try {
      const activeWindow = await getActiveWindowFn();
      const result = await activeWindow();
      appName = result?.owner?.name?.trim() || '(unknown)';
    } catch (err) {
      console.error('active-win failed:', err);
      lastPollAt = now; // prime, skip this slice
      return;
    }
  }

  if (lastPollAt !== null) {
    // (1) Clamp slice duration to the poll interval so a sleep/wake gap can't
    // produce a multi-hour slice.
    const durationMs = Math.min(now - lastPollAt, POLL_INTERVAL_MS);
    const category: Category = idle ? 'other' : config.categorize(appName);
    aggregator.addSlice({ startMs: now - durationMs, endMs: now, category, idle }, config);
  }

  lastPollAt = now;
  if (!idle) currentApp = appName;
  updateStatus(idle ? '(idle)' : appName);
}

// (3) Every flush is a full upsert of the current DailySummary. No deltas, no
// "skip if unchanged" — re-sending the same cumulative summary is idempotent.
async function flushSummary(): Promise<void> {
  const summary = aggregator.buildSummary(deviceId, AGENT_VERSION);
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(summary),
    });
    if (!res.ok) throw new Error(`ingest responded ${res.status}`);
    console.log(
      `Flushed ${summary.date}: active ${summary.activeMinutes}m, focus ${summary.focusMinutes}m, blocks ${summary.focusBlockCount}`,
    );
  } catch (err) {
    // Keep the in-memory totals; the next 15-min flush resends the full summary.
    console.error('Flush failed (will retry next interval):', err);
  }
}

// ---------------------------------------------------------------------------
// Pause ("mark private").
// ---------------------------------------------------------------------------

function setPaused(value: boolean): void {
  paused = value;
  if (paused) aggregator.interrupt();
  lastPollAt = null;
  rebuildTrayMenu();
  updateStatus();
}

// ---------------------------------------------------------------------------
// UI: tray + status window.
// ---------------------------------------------------------------------------

function makeTrayIcon(): Electron.NativeImage {
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

function statusLabel(appOverride?: string): string {
  if (paused) return 'paused (private)';
  return appOverride ?? currentApp;
}

function updateStatus(appOverride?: string): void {
  const label = statusLabel(appOverride);
  tray?.setToolTip(`Pulse — ${label}`);
  win?.webContents.send('status', { paused, app: label });
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: paused ? 'Tracking PAUSED (private)' : 'Tracking active', enabled: false },
      { type: 'separator' },
      {
        label: 'Mark private (pause tracking)',
        type: 'checkbox',
        checked: paused,
        click: (item) => setPaused(item.checked),
      },
      { label: 'Show Pulse', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 380,
    height: 520,
    resizable: false,
    title: 'Pulse',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  win.webContents.on('did-finish-load', () => updateStatus());
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
  rebuildTrayMenu();
  tray.on('click', () => {
    if (win?.isVisible()) win.hide();
    else showWindow();
  });
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

void app.whenReady().then(() => {
  config = loadConfigOrDefault();
  deviceId = loadOrCreateDeviceId();
  aggregator = new DayAggregator(localDateString(new Date()));

  createTray();
  createWindow();

  // IPC for the renderer (Transparency panel + toggle).
  ipcMain.handle('set-paused', (_e, value: unknown) => {
    setPaused(Boolean(value));
    return paused;
  });
  ipcMain.handle('get-status', () => ({ paused, app: statusLabel() }));

  // (1) Sleep/wake + lock/unlock: close any open focus run and avoid forming a
  // slice across the gap. Idle detection already treats a locked screen as idle;
  // these handlers make the run-break explicit and reset the slice clock.
  powerMonitor.on('suspend', () => {
    aggregator.interrupt();
    lastPollAt = null;
  });
  powerMonitor.on('resume', () => {
    lastPollAt = null;
  });
  powerMonitor.on('lock-screen', () => {
    aggregator.interrupt();
    lastPollAt = null;
  });
  powerMonitor.on('unlock-screen', () => {
    lastPollAt = null;
  });

  void poll(); // prime lastPollAt
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  flushTimer = setInterval(() => void flushSummary(), FLUSH_INTERVAL_MS);
});

// Stay alive in the tray when the window is closed.
app.on('window-all-closed', () => {
  /* tray app — do not quit */
});

// Final flush on quit so the last interval isn't lost.
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  if (pollTimer) clearInterval(pollTimer);
  if (flushTimer) clearInterval(flushTimer);
  void flushSummary().finally(() => app.exit(0));
});
