import {
  app,
  BrowserWindow,
  Tray,
  globalShortcut,
  nativeImage,
  ipcMain,
  powerMonitor,
  safeStorage,
  screen,
  shell,
} from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Category, DailySummary } from '@pulse/shared';
import { DayAggregator } from './aggregator.js';
import { loadCanonicalConfig, type CanonicalConfig } from './config.js';
import { Classifier, isAssignableCategory } from './classifier.js';
import { DayStore, type PersistedDay } from './day-store.js';
import { DeviceAuthStore, normalizePairingCode, type PairState } from './device-auth.js';
import { ScoreCache, type TodayScore } from './score-cache.js';
import { WidgetStateStore, type Point } from './widget-state.js';
import { localDateString } from './time.js';

// Dev/smoke-test hook (env-gated, inert in normal runs): an isolated userData
// dir lets a test instance run alongside the real agent without fighting it
// over current-day.json or the device token. Must be set before app ready.
const devUserData = process.env.PULSE_DEV_USER_DATA;
if (devUserData) app.setPath('userData', devUserData);

// ---------------------------------------------------------------------------
// Config — easy to find at the top.
// ---------------------------------------------------------------------------

/**
 * The server this agent PAIRS against. Once paired, all traffic goes to the
 * serverUrl recorded in device.json at pair time — so editing this constant
 * later can never leak an existing token to a different host.
 */
const SERVER_URL = 'http://localhost:3000';

/** How often we sample the focused app + idle state. */
const POLL_INTERVAL_MS = 5_000;

/** How often the current DailySummary is upserted to the backend. */
const FLUSH_INTERVAL_MS = 15 * 60 * 1000;

/** No input for this many seconds = idle (SPEC: "no input > 3 min"). */
const IDLE_THRESHOLD_SECONDS = 180;

/**
 * Startup flush guard: a CURRENT-day flush (scheduled or manual) is blocked
 * until this much uptime has passed AND at least one non-idle observation has
 * been recorded. A freshly-restarted agent therefore can't upsert a near-empty
 * summary over the server's real row. Dated recovery/rollover sends skip this —
 * they carry persisted data that is real by construction.
 */
const STARTUP_FLUSH_DELAY_MS = 60_000;

/** Stamped into every DailySummary. */
const AGENT_VERSION = '0.2.0';

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
// NB (4i): `popover` is now the persistent, draggable WIDGET. The filename and
// variable kept their 4h "popover" name to hold the churn down — the window
// MODE changed (frameless card → movable companion), not the card itself.
let popover: BrowserWindow | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
/** Score auto-refresh while the widget is visible; paused (cleared) while hidden. */
let widgetRefreshTimer: ReturnType<typeof setInterval> | null = null;
/** Debounce for persisting the window position after a drag settles. */
let widgetMoveSaveTimer: ReturnType<typeof setTimeout> | null = null;
/** Pin-on-top state, restored from widget-state.json; default OFF. */
let widgetPinned = false;
/** Compact "pill" view (score only) vs the full card; restored from disk. */
let widgetCompact = false;
/** Last top-left of each mode, kept separately so collapse/expand return to where
 *  that mode was left. null → place at the default corner. Restored from disk. */
let widgetCardPos: Point | null = null;
let widgetPillPos: Point | null = null;
/** Persists pin + compact + each mode's position (atomic, sibling of score-cache.json). */
let widgetState: WidgetStateStore;

let canonical: CanonicalConfig;
let classifier: Classifier;
let aggregator: DayAggregator;
let dayStore: DayStore;
let deviceId: string;
let deviceAuth: DeviceAuthStore;
/** One log line per unpaired stretch, not one per skipped 15-min flush. */
let unpairedSkipLogged = false;

/** Wall-clock ms when this agent process started — drives the startup flush guard. */
let startedAtMs = 0;
/** Non-idle slices recorded since this process started (NOT restored across restarts). */
let observationsThisSession = 0;
/** True while a recovery-pending retry is running, so retries never overlap. */
let recoveryInFlight = false;

/** Last classifier revision pushed to the renderer, so we only push on change. */
let lastPushedClassifierRev = -1;

/** True while a flush is in flight, so overlapping triggers are dropped. */
let flushInFlight = false;
/** Wall-clock ms of the last SUCCESSFUL flush, or null if none yet. */
let lastFlushAt: number | null = null;

/**
 * The paired ACCOUNT's identity (email), fetched from /api/me. MEMORY-ONLY by
 * design: email is PII, so it is never written to disk — device.json stays
 * non-secret metadata only — and is refetched on every startup instead.
 * 'invalid' means the server 401'd the token; display only — the ingest 401
 * path owns actually wiping a dead credential.
 */
type AccountIdentity =
  | { status: 'unpaired' }
  | { status: 'checking' }
  | { status: 'ok'; email: string; displayName: string | null }
  | { status: 'invalid' }
  | { status: 'error' };
let account: AccountIdentity = { status: 'unpaired' };

/**
 * Last-known SERVER-computed score for the popover (4h). The agent never
 * computes any of this — it renders what /api/agent/today returned, cached on
 * disk (score-cache.json) so the popover opens instantly and refreshes behind.
 */
let scoreCache: ScoreCache;
let todayScore: TodayScore | null = null;
/** Overlapping refreshes are dropped, same pattern as the flush guard. */
let scoreFetchInFlight = false;

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

function loadCanonicalOrDefault(): CanonicalConfig {
  const file = path.join(__dirname, '../config/categories.json');
  try {
    return loadCanonicalConfig(file);
  } catch (err) {
    // With an empty canonical map, everything falls to heuristics then 'unknown'
    // (neutral) — never silently to 'other'. A bad config can't tank the score.
    console.error('Failed to load categories.json — relying on heuristics only:', err);
    return {
      productive: new Set<Category>(),
      lookup: () => undefined,
      isProductive: () => false,
    };
  }
}

/**
 * Send a state push to every open renderer (Transparency panel + popover).
 * One state model, two views — the popover subscribes to the same channels
 * the panel always has instead of growing a parallel set.
 */
function broadcast(channel: string, payload: unknown): void {
  for (const w of [win, popover]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** How many unknown apps have crossed the "ask about it" threshold (Unit 3). */
function unknownQueueCount(): number {
  return classifier.getState().unknownQueue.length;
}

/** Push the classify-nudge count to BOTH windows (widget badge + panel). */
function pushClassifyNudge(): void {
  broadcast('classify-nudge', { count: unknownQueueCount() });
}

/**
 * Push classifier state to the renderer, but only when it actually changed.
 * The full app list goes to the panel only; the widget gets just the nudge
 * COUNT (no app names cross to the widget — they never need to). Both are
 * agent-local either way (CLAUDE.md: the unknown state is never transmitted).
 */
function pushClassifierStateIfChanged(): void {
  if (classifier.revision === lastPushedClassifierRev) return;
  lastPushedClassifierRev = classifier.revision;
  const state = classifier.getState();
  win?.webContents.send('classifier-state', state);
  broadcast('classify-nudge', { count: state.unknownQueue.length });
}

// ---------------------------------------------------------------------------
// Tracking loop.
// ---------------------------------------------------------------------------

async function poll(): Promise<void> {
  const now = Date.now();
  const today = localDateString(new Date(now));

  // (2) Day rollover: snapshot the finished day, reset for today FIRST (so a
  // slow send can't race overlapping polls into the old day), then send the
  // finished day directly via sendSummary — it carries real, dated data, so the
  // startup flush guard doesn't apply. If the send fails, the day is parked as
  // a recovery-pending file instead of being discarded.
  if (today !== aggregator.date) {
    dayStore.cancelPendingSave(); // a pending debounced write is for the OLD day
    const finished = aggregator.buildSummary(deviceId, AGENT_VERSION);
    aggregator = new DayAggregator(today);
    classifier.resetDay();
    lastPollAt = null; // never form a slice spanning midnight
    dayStore.saveNow(currentPersistedState()); // empty today replaces the old snapshot
    const result = await sendSummary(finished);
    if (!result.ok && finished.activeMinutes > 0) {
      dayStore.writeRecoveryPending({ localDate: finished.date, summary: finished });
      logRecovery(
        `rollover flush for ${finished.date} failed (${result.error ?? 'unknown'}) — parked as recovery-pending`,
      );
    }
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

    if (idle) {
      // Idle slices are excluded from everything; category/source are ignored.
      aggregator.addSlice(
        { startMs: now - durationMs, endMs: now, category: 'other', source: 'canonical', idle: true },
        canonical,
      );
    } else {
      const classification = classifier.classify(appName);
      aggregator.addSlice(
        {
          startMs: now - durationMs,
          endMs: now,
          category: classification.category,
          source: classification.source,
          idle: false,
        },
        canonical,
      );
      // Record the observation (seen registry + unknown tracking). minutesToday
      // and the unknown-apps file both come from this.
      classifier.recordObservation(classification, appName, durationMs / 60000);
      observationsThisSession += 1;
    }
    // Persist the day shortly after every state change (idle slices can bank a
    // focus block, so they count as a change too).
    dayStore.scheduleSave(currentPersistedState);
  }

  lastPollAt = now;
  if (!idle) currentApp = appName;
  updateStatus(idle ? '(idle)' : appName);
  pushClassifierStateIfChanged();
}

/**
 * Outcome of a flush attempt, returned so callers can surface success/failure.
 * `notReady: true` means the startup flush guard blocked it (not a failure);
 * `error` then carries the human-readable reason for the panel.
 */
type FlushResult = { ok: boolean; at: number; error?: string; notReady?: boolean };

/** The current day's state in its persisted shape (read fresh at call time). */
function currentPersistedState(): PersistedDay {
  return {
    localDate: aggregator.date,
    summary: aggregator.buildSummary(deviceId, AGENT_VERSION),
    // Panel state rides along in the same snapshot so per-app minutes and the
    // last-flush time survive a restart. Local-only; never sent to the server.
    seenApps: classifier.getSeenSnapshot(),
    lastFlushAt,
  };
}

/** Append one line to userData/recovery-log.txt (best-effort, local-only). */
function logRecovery(line: string): void {
  console.log(`recovery: ${line}`);
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'recovery-log.txt'),
      `${new Date().toISOString()} ${line}\n`,
    );
  } catch {
    // logging must never break the agent
  }
}

// (3) Every send is a full upsert of a DailySummary. No deltas, no "skip if
// unchanged" — within a day the agent's state only grows, so re-sending is
// idempotent and a re-send can only add, never clobber. This is the ONE POST
// implementation; the live flush, day rollover, recovery flush, and quit flush
// all go through it. The in-flight guard drops overlapping triggers.
//
// Phase 4b: every send carries the device bearer token, and dated recovery
// sends go through here too — so they authenticate exactly like live flushes.
// summary.userId still holds the old device UUID purely to satisfy the
// contract shape; the server derives the real user from the token.
async function sendSummary(summary: DailySummary): Promise<FlushResult> {
  if (flushInFlight) {
    return { ok: false, at: Date.now(), error: 'A flush is already in progress.' };
  }
  flushInFlight = true;
  try {
    // Sanity check (C): an all-zero summary from a session that has observed
    // nothing is the restart-wipe signature, not real data. Never POST it.
    if (summary.activeMinutes === 0 && observationsThisSession === 0) {
      console.warn(
        `Refusing to send all-zero summary for ${summary.date}: no observations this session.`,
      );
      return { ok: false, at: Date.now(), error: 'Nothing to send yet (no activity observed).' };
    }

    // Not paired = nothing leaves the machine. Today keeps accumulating in
    // current-day.json and past days stay parked as recovery-pending files,
    // so pairing later drains everything. notReady — this isn't a failure.
    const token = deviceAuth.token;
    if (!token) {
      if (!unpairedSkipLogged) {
        console.log('Not paired — tracking locally; sends are on hold until this device is paired.');
        unpairedSkipLogged = true;
      }
      return {
        ok: false,
        at: Date.now(),
        error: 'Not paired — pair this device to send summaries.',
        notReady: true,
      };
    }
    unpairedSkipLogged = false;

    // The token is only ever sent to the server it was paired against.
    const serverUrl = deviceAuth.metadata?.serverUrl ?? SERVER_URL;
    const res = await fetch(`${serverUrl}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(summary),
    });
    if (res.status === 401) {
      // The server definitively rejected the credential (revoked or deleted).
      // Wipe it and surface the not-paired banner — do NOT retry forever.
      // Only this exact status wipes; network errors and 5xx keep the token.
      console.error('Device token rejected by the server — unpairing locally. Re-pair from the web app.');
      deviceAuth.wipe();
      setAccount({ status: 'unpaired' }); // also pushes pair state
      clearTodayScore(); // the cached score belonged to that pairing
      return {
        ok: false,
        at: Date.now(),
        error: 'Device token rejected — re-pair this device from the web app.',
      };
    }
    if (!res.ok) throw new Error(`ingest responded ${res.status}`);
    console.log(
      `Flushed ${summary.date}: active ${summary.activeMinutes}m, focus ${summary.focusMinutes}m, blocks ${summary.focusBlockCount}`,
    );
    lastFlushAt = Date.now();
    dayStore.scheduleSave(currentPersistedState); // lastFlushAt is part of the snapshot
    return { ok: true, at: lastFlushAt };
  } catch (err) {
    // The caller keeps its data; the next attempt resends the full summary.
    const message = err instanceof Error ? err.message : String(err);
    console.error('Flush failed (will retry):', err);
    return { ok: false, at: Date.now(), error: message };
  } finally {
    flushInFlight = false;
    notifyFlushState();
  }
}

/** Startup flush guard (B): is a CURRENT-day flush allowed yet? */
function flushReadiness(): { ready: boolean; message?: string } {
  const elapsed = Date.now() - startedAtMs;
  if (elapsed < STARTUP_FLUSH_DELAY_MS) {
    const remaining = Math.ceil((STARTUP_FLUSH_DELAY_MS - elapsed) / 1000);
    return { ready: false, message: `Flush available in ${remaining}s` };
  }
  if (observationsThisSession === 0) {
    return { ready: false, message: 'Waiting for first activity before flushing.' };
  }
  return { ready: true };
}

// The current-day live flush: readiness guard, then send today's summary. The
// scheduled timer and the manual trigger both go through this. A success also
// retries one parked recovery-pending day, so a recovering server drains the
// backlog without any extra machinery.
async function flushSummary(): Promise<FlushResult> {
  const readiness = flushReadiness();
  if (!readiness.ready) {
    return { ok: false, at: Date.now(), error: readiness.message, notReady: true };
  }
  const result = await sendSummary(aggregator.buildSummary(deviceId, AGENT_VERSION));
  if (result.ok) void retryOneRecoveryPending();
  return result;
}

/**
 * Try to send the OLDEST recovery-pending day. Returns true if the queue moved
 * (sent, or removed as empty/corrupt) — i.e. it's worth trying the next file.
 * One file per send attempt; never overlaps itself.
 */
async function retryOneRecoveryPending(): Promise<boolean> {
  if (recoveryInFlight) return false;
  recoveryInFlight = true;
  try {
    const [file] = dayStore.listRecoveryPending();
    if (!file) return false;
    const data = dayStore.readRecoveryPending(file);
    if (!data) {
      dayStore.quarantineRecoveryPending(file);
      logRecovery(`pending file ${path.basename(file)} was corrupt — quarantined`);
      return true;
    }
    if (data.summary.activeMinutes === 0) {
      dayStore.removeRecoveryPending(file);
      logRecovery(`pending file ${path.basename(file)} had no activity — removed without sending`);
      return true;
    }
    const result = await sendSummary(data.summary);
    logRecovery(
      `recovery flush for ${data.localDate}: ${result.ok ? 'ok' : `failed (${result.error ?? 'unknown'})`}`,
    );
    if (result.ok) {
      dayStore.removeRecoveryPending(file);
      return true;
    }
    return false;
  } finally {
    recoveryInFlight = false;
  }
}

/** Drain the recovery queue oldest-first, stopping at the first failure. */
async function retryAllRecoveryPending(): Promise<void> {
  while (await retryOneRecoveryPending()) {
    // each successful iteration removed one file; keep going until empty or stuck
  }
}

// Manual flush trigger (tray "Flush now" + the 'flush-now' IPC). Runs the exact
// same flush, then resets the schedule so the NEXT automatic flush is a full
// interval away from this one — avoids a manual flush being chased by a
// scheduled one seconds later.
async function flushNow(): Promise<FlushResult> {
  const result = await flushSummary();
  armFlushTimer();
  return result;
}

// (Re)arm the scheduled flush timer. Clearing and recreating it restarts the
// 15-minute countdown; used at startup and after every manual flush. The
// interval default itself is never changed.
function armFlushTimer(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => void flushSummary(), FLUSH_INTERVAL_MS);
}

// Push the last-flush timestamp so "Last flushed: …" stays current everywhere.
function notifyFlushState(): void {
  broadcast('flush-state', { lastFlushAt });
}

// ---------------------------------------------------------------------------
// Device pairing (Phase 4b).
//
// The agent trades a short-lived code (issued on the user's authenticated
// /settings/devices page) for a long-lived bearer token via the public
// pair/consume endpoint. The token is held in memory and persisted only as a
// safeStorage-encrypted blob — see device-auth.ts.
// ---------------------------------------------------------------------------

type PairStateForPanel = PairState & { defaultLabel: string; account: AccountIdentity };

function pairStateForPanel(): PairStateForPanel {
  return { ...deviceAuth.getPairState(), defaultLabel: os.hostname(), account };
}

function pushPairState(): void {
  broadcast('pair-state', pairStateForPanel());
}

/** Update the account identity everywhere it shows: popover + panel. */
function setAccount(next: AccountIdentity): void {
  account = next;
  pushPairState();
}

/**
 * Ask the paired server who this device belongs to (GET /api/me, bearer token).
 * Called on startup after the credential is restored and after a successful
 * pair — never persisted, so a stale email can't outlive the pairing it came
 * from. Talks ONLY to the serverUrl recorded at pair time, like every other
 * authenticated call.
 */
async function refreshAccountIdentity(): Promise<void> {
  const token = deviceAuth.token;
  if (!token) {
    setAccount({ status: 'unpaired' });
    return;
  }
  setAccount({ status: 'checking' });
  const serverUrl = deviceAuth.metadata?.serverUrl ?? SERVER_URL;
  try {
    const res = await fetch(`${serverUrl}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      // Token revoked/deleted. Show it; the next ingest 401 wipes the credential.
      setAccount({ status: 'invalid' });
      return;
    }
    if (!res.ok) throw new Error(`whoami responded ${res.status}`);
    const body = (await res.json()) as { email?: unknown; displayName?: unknown };
    if (typeof body.email !== 'string' || body.email.length === 0) {
      throw new Error('whoami response was malformed');
    }
    setAccount({
      status: 'ok',
      email: body.email,
      displayName: typeof body.displayName === 'string' ? body.displayName : null,
    });
  } catch (err) {
    // Server down or unreachable — unknown, not invalid. Retried next startup.
    console.log('Could not verify the paired account (will retry on next launch):', err);
    setAccount({ status: 'error' });
  }
}

function pushTodayScore(): void {
  broadcast('today-score', todayScore);
}

/** Unpair/401: the cached score belonged to that pairing — drop it everywhere. */
function clearTodayScore(): void {
  todayScore = null;
  scoreCache.clear();
  pushTodayScore();
}

/**
 * Refresh the popover's score from GET /api/agent/today (4h). The score and
 * message arrive FINISHED from the server — no scoring math exists agent-side.
 * Fired on popover open, startup, and after pairing; failures keep the cached
 * value (the popover shows its freshness hint, so stale is visible, not silent).
 */
async function refreshTodayScore(): Promise<void> {
  const token = deviceAuth.token;
  if (!token) {
    // Unpaired: settle the popover into its empty state rather than leaving
    // it on "Checking today…" forever.
    pushTodayScore();
    return;
  }
  if (scoreFetchInFlight) return;
  scoreFetchInFlight = true;
  try {
    // The AGENT is the client here: it sends its own local civil day, the same
    // way the browser does for /api/dashboard. The server never derives "today".
    const date = localDateString(new Date());
    const serverUrl = deviceAuth.metadata?.serverUrl ?? SERVER_URL;
    const res = await fetch(`${serverUrl}/api/agent/today?date=${date}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // 401: the identity layer (and the next flush) own that story; keep quiet
    // here and keep the cache — wiping is the ingest 401 path's job alone.
    if (res.status === 401) return;
    if (!res.ok) throw new Error(`agent/today responded ${res.status}`);
    const body = (await res.json()) as {
      date?: unknown;
      score?: unknown;
      displayScore?: unknown;
      message?: unknown;
      isWorkingDay?: unknown;
      lastActivityAt?: unknown;
    };
    if (
      typeof body.date !== 'string' ||
      (body.score !== null && typeof body.score !== 'number') ||
      (body.displayScore !== null && typeof body.displayScore !== 'number') ||
      (body.message !== null && typeof body.message !== 'string') ||
      typeof body.isWorkingDay !== 'boolean' ||
      (body.lastActivityAt !== null && typeof body.lastActivityAt !== 'string')
    ) {
      throw new Error('agent/today response was malformed');
    }
    todayScore = {
      date: body.date,
      score: body.score as number | null,
      displayScore: body.displayScore as number | null,
      message: body.message as string | null,
      isWorkingDay: body.isWorkingDay,
      lastActivityAt: body.lastActivityAt as string | null,
      fetchedAt: Date.now(),
    };
    scoreCache.save(todayScore);
    pushTodayScore();
  } catch (err) {
    console.log('Score refresh failed (popover keeps the cached value):', err);
  } finally {
    scoreFetchInFlight = false;
  }
}

type PairResult = { ok: true } | { ok: false; error: string };

async function pairWithCode(rawCode: unknown, rawLabel: unknown): Promise<PairResult> {
  if (!safeStorage.isEncryptionAvailable()) {
    // Rare (e.g. Linux without libsecret). A plaintext token on disk is worse
    // than no pairing, so refuse outright rather than fall back.
    console.error(
      'safeStorage reports OS-level encryption is UNAVAILABLE — refusing to pair. ' +
        'The device token cannot be stored safely on this machine.',
    );
    return { ok: false, error: 'This machine cannot store the token securely (OS encryption unavailable).' };
  }

  const code = normalizePairingCode(typeof rawCode === 'string' ? rawCode : '');
  const label = (typeof rawLabel === 'string' ? rawLabel : '').trim() || os.hostname();
  if (code.length === 0) return { ok: false, error: 'Enter the pairing code from the web app.' };

  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}/api/devices/pair/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceLabel: label }),
    });
  } catch {
    return { ok: false, error: `Could not reach the server at ${SERVER_URL}. Is it running?` };
  }

  if (res.status === 400) return { ok: false, error: 'Invalid or expired code.' };
  if (!res.ok) return { ok: false, error: `Pairing failed (server responded ${res.status}).` };

  let payload: { token?: unknown; deviceId?: unknown; userId?: unknown; deviceLabel?: unknown };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    return { ok: false, error: 'Pairing failed (unreadable server response).' };
  }
  if (
    typeof payload.token !== 'string' ||
    payload.token.length === 0 ||
    typeof payload.deviceId !== 'string' ||
    payload.deviceId.length === 0 ||
    typeof payload.userId !== 'string'
  ) {
    return { ok: false, error: 'Pairing failed (malformed server response).' };
  }

  deviceAuth.store(payload.token, {
    deviceId: payload.deviceId,
    userId: payload.userId,
    label: typeof payload.deviceLabel === 'string' && payload.deviceLabel.length > 0 ? payload.deviceLabel : label,
    pairedAt: new Date().toISOString(),
    serverUrl: SERVER_URL,
  });
  unpairedSkipLogged = false;
  pushPairState();
  console.log('Paired — flushes will resume on the next interval.');
  // Show which account this device now feeds, right away — and its score.
  void refreshAccountIdentity();
  void refreshTodayScore();
  // Send the day so far right away rather than waiting up to 15 minutes (the
  // startup guard may still defer it), and drain any days that were parked
  // while unpaired — dated recovery sends skip the startup guard by design.
  void flushSummary().finally(() => void retryAllRecoveryPending());
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pause ("mark private").
// ---------------------------------------------------------------------------

function setPaused(value: boolean): void {
  paused = value;
  if (paused) {
    aggregator.interrupt();
    dayStore.scheduleSave(currentPersistedState); // interrupt may bank a focus block
  }
  lastPollAt = null;
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
  broadcast('status', { paused, app: label });
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
  win.webContents.on('did-finish-load', () => {
    updateStatus();
    lastPushedClassifierRev = -1; // force a push to the freshly-loaded page
    pushClassifierStateIfChanged();
    notifyFlushState();
    pushPairState();
  });
  win.on('closed', () => {
    win = null;
  });
}

function showWindow(): void {
  if (!win) createWindow();
  else win.show();
}

// ---------------------------------------------------------------------------
// Tray widget (4i): a persistent, DRAGGABLE companion card. It evolved from
// the 4h frameless popover — same creation/preload/IPC pattern as the
// Transparency panel, same card markup — but the window MODE changed:
//   - no blur-dismiss (a companion must not vanish on click-away); the card's
//     × hides it (HIDE, not quit — the agent keeps running, the tray brings
//     it back) and Esc still hides.
//   - draggable via the card header (-webkit-app-region in popover.html).
//   - pin-on-top toggle (default OFF) that flips setAlwaysOnTop live.
//   - position + pin persist to widget-state.json and restore on launch,
//     clamped into the nearest display's work area.
//   - shown in the taskbar (skipTaskbar dropped) so a persistent window is
//     findable; tray click shows/raises/focuses it (never toggles it closed).
// ---------------------------------------------------------------------------

const WIDGET_WIDTH = 340;
const WIDGET_HEIGHT = 442;
/** Compact "pill" dimensions — just the score + its band color (Unit 2). */
const PILL_WIDTH = 152;
const PILL_HEIGHT = 76;
/**
 * Resting gap between the WINDOW and the screen edge when snapped or defaulted.
 * Deliberately tiny: the card/pill already carry an ~8px transparent margin
 * inside the window, so this lands the visible widget a couple mm off the edge.
 */
const EDGE_GAP = 2;

/** Outer size for the current mode — drives creation and the toggle resize. */
function widgetSize(): { width: number; height: number } {
  return widgetCompact
    ? { width: PILL_WIDTH, height: PILL_HEIGHT }
    : { width: WIDGET_WIDTH, height: WIDGET_HEIGHT };
}
/**
 * Score auto-refresh cadence while the widget is visible. The score only moves
 * when the agent flushes (15-min cadence) or another device posts, so 5 min
 * keeps the "updated N min ago" hint honest without wasteful polling. Paused
 * entirely while hidden — no point fetching for a window nobody can see.
 */
const WIDGET_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** A drag that settles within this many px of a flush edge snaps to it. */
const SNAP_THRESHOLD = 56;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Clamp a desired top-left so the WHOLE window (at `size`) sits inside a visible
 * work area. getDisplayNearestPoint maps a point on a now-disconnected monitor
 * back onto an existing display, so a position saved on hardware that's since
 * vanished snaps to somewhere visible instead of opening off-screen.
 */
function clampToWorkArea(x: number, y: number, size: { width: number; height: number }): Point {
  const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
  return {
    x: Math.round(clamp(x, wa.x, wa.x + wa.width - size.width)),
    y: Math.round(clamp(y, wa.y, wa.y + wa.height - size.height)),
  };
}

/**
 * After a drag settles, pull the window flush to a screen edge/corner if it's
 * within SNAP_THRESHOLD of one (per-axis: a corner docks both axes; a single
 * near edge flush-aligns that side, EDGE_GAP off the screen). The result is then
 * CLAMPED fully on-screen, so the axis that didn't snap can never be left hanging
 * off a side — and a drag released partly off an edge is pulled back regardless.
 * Flush uses the same EDGE_GAP as the default corner, so snapped == default spot.
 */
function snapToCornerIfNear(): void {
  if (!popover || popover.isDestroyed()) return;
  const b = popover.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const leftFlush = wa.x + EDGE_GAP;
  const rightFlush = wa.x + wa.width - b.width - EDGE_GAP;
  const topFlush = wa.y + EDGE_GAP;
  const bottomFlush = wa.y + wa.height - b.height - EDGE_GAP;

  let x = b.x;
  let y = b.y;
  if (Math.abs(b.x - leftFlush) <= SNAP_THRESHOLD) x = leftFlush;
  else if (Math.abs(b.x - rightFlush) <= SNAP_THRESHOLD) x = rightFlush;
  if (Math.abs(b.y - topFlush) <= SNAP_THRESHOLD) y = topFlush;
  else if (Math.abs(b.y - bottomFlush) <= SNAP_THRESHOLD) y = bottomFlush;

  // Keep the whole window on-screen even on an un-snapped axis.
  x = Math.round(clamp(x, wa.x, wa.x + wa.width - b.width));
  y = Math.round(clamp(y, wa.y, wa.y + wa.height - b.height));
  if (x !== b.x || y !== b.y) popover.setPosition(x, y);
}

/**
 * Correct the LIVE window so the whole of it sits inside the nearest work area,
 * using its ACTUAL bounds. Windows reports a frameless-transparent window a few
 * px larger than requested (an invisible DWM resize border), so clamping by the
 * WIDGET_WIDTH constant alone can leave an edge off-screen — measure instead.
 * Also re-runs on every show, so a monitor unplugged while hidden self-heals.
 */
function clampWidgetIntoView(): void {
  if (!popover || popover.isDestroyed()) return;
  const b = popover.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const x = Math.round(clamp(b.x, wa.x, wa.x + wa.width - b.width));
  const y = Math.round(clamp(b.y, wa.y, wa.y + wa.height - b.height));
  if (x !== b.x || y !== b.y) popover.setPosition(x, y);
}

/** Default placement for a window of `size`: bottom-right corner, near the tray.
 *  Used for first-ever launch AND the first time a mode (card or pill) is shown. */
function defaultPositionFor(size: { width: number; height: number }): Point {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x + wa.width - size.width - EDGE_GAP,
    y: wa.y + wa.height - size.height - EDGE_GAP,
  };
}

/** Record the live bounds into the ACTIVE mode's slot and persist both (atomic). */
function persistWidgetState(): void {
  if (!popover || popover.isDestroyed()) return;
  const b = popover.getBounds();
  const pos: Point = { x: b.x, y: b.y };
  if (widgetCompact) widgetPillPos = pos;
  else widgetCardPos = pos;
  widgetState.save({ pinned: widgetPinned, compact: widgetCompact, card: widgetCardPos, pill: widgetPillPos });
}

/** Run the score refresh on a timer only while the widget is actually visible. */
function syncWidgetRefreshTimer(): void {
  const visible = !!popover && !popover.isDestroyed() && popover.isVisible() && !popover.isMinimized();
  if (visible && !widgetRefreshTimer) {
    widgetRefreshTimer = setInterval(() => void refreshTodayScore(), WIDGET_REFRESH_INTERVAL_MS);
  } else if (!visible && widgetRefreshTimer) {
    clearInterval(widgetRefreshTimer);
    widgetRefreshTimer = null;
  }
}

function createPopover(): void {
  // Restore pin + compact + each mode's position, or fall back to defaults.
  const saved = widgetState.load();
  widgetPinned = saved?.pinned ?? false;
  widgetCompact = saved?.compact ?? false;
  widgetCardPos = saved?.card ?? null;
  widgetPillPos = saved?.pill ?? null;
  const size = widgetSize();
  const activeSaved = widgetCompact ? widgetPillPos : widgetCardPos;
  const pos = activeSaved ? clampToWorkArea(activeSaved.x, activeSaved.y, size) : defaultPositionFor(size);
  if (process.env.PULSE_DEV_OPEN_POPOVER === '1') {
    console.log(
      `widget: saved=${JSON.stringify(saved)} -> restored=${JSON.stringify(pos)} ` +
        `pinned=${widgetPinned} compact=${widgetCompact}`,
    );
  }

  popover = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true, // the card's rounded corners need a transparent backing
    resizable: false,
    alwaysOnTop: widgetPinned, // default OFF; the saved pin state wins
    skipTaskbar: false, // a persistent widget must be findable in the taskbar
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void popover.loadFile(path.join(__dirname, '../src/renderer/popover.html'));
  popover.webContents.on('did-finish-load', () => {
    updateStatus();
    notifyFlushState();
    pushPairState();
    pushTodayScore();
    pushClassifyNudge();
  });
  // After a drag settles: snap to a near edge/corner, then persist this mode's
  // (snapped) position. Debounced so it runs once the move stops, regardless of
  // how often 'moved' fires. The snap's own setPosition re-fires 'moved' once,
  // but snapping is idempotent (already-flush → no move) so it settles.
  popover.on('moved', () => {
    if (widgetMoveSaveTimer) clearTimeout(widgetMoveSaveTimer);
    widgetMoveSaveTimer = setTimeout(() => {
      snapToCornerIfNear();
      persistWidgetState();
    }, 150);
  });
  // No blur-dismiss (4i): a companion widget stays put on click-away. Pause/
  // resume the refresh timer as visibility changes instead.
  popover.on('show', syncWidgetRefreshTimer);
  popover.on('hide', syncWidgetRefreshTimer);
  popover.on('minimize', syncWidgetRefreshTimer);
  popover.on('restore', syncWidgetRefreshTimer);
  popover.on('closed', () => {
    if (widgetRefreshTimer) {
      clearInterval(widgetRefreshTimer);
      widgetRefreshTimer = null;
    }
    popover = null;
  });
}

/** Show / raise / focus the widget, creating it if it was closed. */
function showWidget(): void {
  if (!popover || popover.isDestroyed()) createPopover();
  const p = popover;
  if (!p) return;
  if (p.isMinimized()) p.restore();

  const reveal = () => {
    p.show();
    clampWidgetIntoView(); // correct against ACTUAL bounds, now the window is realized
    p.focus();
    syncWidgetRefreshTimer();
    // Cached value is already on screen — refresh behind it.
    void refreshTodayScore();
  };
  // First-ever show: a transparent window painted pre-load reads as a blank
  // flash. Defer that one show to the finished load.
  if (p.webContents.isLoading()) {
    p.webContents.once('did-finish-load', reveal);
  } else {
    reveal();
  }
}

/** Flip pin-on-top live and persist it. Returns the new pin state. */
function setWidgetPinned(value: boolean): boolean {
  widgetPinned = value;
  if (popover && !popover.isDestroyed()) popover.setAlwaysOnTop(value);
  persistWidgetState();
  return widgetPinned;
}

/**
 * Switch between the full card and the compact pill (Unit 2). Each mode keeps
 * its OWN position: we save where the leaving mode sat, then move to where the
 * entering mode was last left (or its default corner the first time). Resizes,
 * then RE-RUNS the existing clamp so a pill growing back into a card near an
 * edge can't end up off-screen. Purely presentational. Returns the new mode.
 */
function setWidgetCompact(value: boolean): boolean {
  if (popover && !popover.isDestroyed()) {
    // Remember where the CURRENT mode sits before we leave it.
    const b = popover.getBounds();
    if (widgetCompact) widgetPillPos = { x: b.x, y: b.y };
    else widgetCardPos = { x: b.x, y: b.y };

    widgetCompact = value;
    const size = widgetSize();
    const target = (widgetCompact ? widgetPillPos : widgetCardPos) ?? defaultPositionFor(size);
    popover.setBounds({ x: target.x, y: target.y, width: size.width, height: size.height });
    clampWidgetIntoView(); // reuse — never duplicate the clamp logic
  } else {
    widgetCompact = value;
  }
  persistWidgetState();
  return widgetCompact;
}

function createTray(): void {
  tray = new Tray(makeTrayIcon());
  // No native context menu (4h): the widget IS the menu now. Tray click (left
  // or right) shows/raises it — closing is the card's × only (4i).
  tray.on('click', showWidget);
  tray.on('right-click', showWidget);
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

void app.whenReady().then(() => {
  startedAtMs = Date.now();
  canonical = loadCanonicalOrDefault();
  deviceId = loadOrCreateDeviceId();
  classifier = new Classifier({
    canonical,
    overridesPath: path.join(app.getPath('userData'), 'user-overrides.json'),
    unknownPath: path.join(app.getPath('userData'), 'unknown-apps.json'),
  });

  // safeStorage is only usable after whenReady — construct and restore the
  // pairing credential FIRST: the recovery drain below sends authenticated
  // requests, so the token must be in memory before any send can fire.
  // A restored token is presumed valid until a flush 401 says otherwise.
  deviceAuth = new DeviceAuthStore(app.getPath('userData'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(blob),
  });
  deviceAuth.load();
  const pairState = deviceAuth.getPairState();
  console.log(pairState.paired ? `Paired as "${pairState.label}".` : 'Not paired.');
  // Resolve WHICH account this device feeds (memory-only; refetched every
  // launch). Until it answers, the popover/panel show "checking…".
  void refreshAccountIdentity();

  // Last-known server score: cached so the popover's first open is instant,
  // refreshed in the background now and on every open.
  scoreCache = new ScoreCache(app.getPath('userData'));
  todayScore = scoreCache.load();
  void refreshTodayScore();

  // Draggable-widget window state (4i): last position + pin, restored on show.
  widgetState = new WidgetStateStore(app.getPath('userData'));

  // (A) Resume today from the persisted snapshot if there is one; otherwise
  // start fresh. A snapshot for a DIFFERENT date means the agent was down
  // across midnight: park it as recovery-pending and flush it below for its
  // own date (Option 2 — recover-flush). Upserts are monotonic within a day
  // (the snapshot is always >= the last server flush), so the re-POST strictly
  // adds and the dated row can never lose data.
  dayStore = new DayStore(app.getPath('userData'));
  const today = localDateString(new Date());
  const persisted = dayStore.load();
  if (persisted && persisted.localDate === today) {
    aggregator = DayAggregator.restore(persisted.summary);
    // Panel state rides in the same snapshot: per-app minutes (incl. unknowns,
    // so the 10-min queue threshold spans restarts) and the last-flush time.
    classifier.restoreSeen(persisted.seenApps);
    lastFlushAt = persisted.lastFlushAt ?? null;
    console.log(
      `Restored ${today} from snapshot: active ${persisted.summary.activeMinutes}m, focus ${persisted.summary.focusMinutes}m`,
    );
  } else {
    if (persisted) {
      dayStore.writeRecoveryPending(persisted);
      logRecovery(
        `startup found snapshot for ${persisted.localDate} (today is ${today}) — parked for recovery flush`,
      );
    }
    aggregator = new DayAggregator(today);
    dayStore.saveNow(currentPersistedState()); // overwrite the snapshot with empty today
  }
  // Drain any parked days (including one just parked above), oldest first.
  // These carry real dated data, so they skip the startup guard by design.
  // When not paired, sendSummary returns notReady and the files stay parked —
  // pairing later (or the post-pair immediate flush) drains them.
  void retryAllRecoveryPending();

  // IPC for the renderer (Transparency panel + toggle). Registered BEFORE the
  // window exists so no renderer invoke can ever race an unregistered handler.
  ipcMain.handle('set-paused', (_e, value: unknown) => {
    setPaused(Boolean(value));
    return paused;
  });
  ipcMain.handle('get-status', () => ({ paused, app: statusLabel() }));

  // Transparency panel: the seen-apps list and the unrecognized-apps queue.
  ipcMain.handle('get-classifier-state', () => classifier.getState());

  // User classifies/reclassifies an app. Overrides win over canonical and
  // heuristics, and take effect on the NEXT poll with no restart.
  ipcMain.handle('classify-app', (_e, payload: unknown) => {
    const { normalized, category } = (payload ?? {}) as {
      normalized?: unknown;
      category?: unknown;
    };
    if (typeof normalized !== 'string' || !normalized || !isAssignableCategory(category)) {
      return classifier.getState(); // ignore malformed input, return current state
    }
    classifier.setOverride(normalized, category);
    lastPushedClassifierRev = classifier.revision; // we're returning it right now
    pushClassifyNudge(); // the widget badge must drop as the queue shrinks
    return classifier.getState();
  });

  // Manual flush: same path as the scheduled flush, resets the schedule.
  ipcMain.handle('flush-now', () => flushNow());
  ipcMain.handle('get-flush-state', () => ({ lastFlushAt }));

  // Widget (4h score path / 4i window mode). The score is server-computed and
  // cached; the renderer only ever sees the finished TodayScore.
  ipcMain.handle('get-today-score', () => todayScore);
  // × and Esc both HIDE (not quit) — the agent keeps running, the tray restores.
  ipcMain.handle('popover-hide', () => popover?.hide());
  ipcMain.handle('set-pinned', (_e, value: unknown) => setWidgetPinned(Boolean(value)));
  ipcMain.handle('set-compact', (_e, value: unknown) => setWidgetCompact(Boolean(value)));
  ipcMain.handle('get-widget-state', () => ({ pinned: widgetPinned, compact: widgetCompact }));
  // Unit 3: how many unknown apps have crossed the "ask about it" threshold.
  ipcMain.handle('get-classify-nudge', () => ({ count: unknownQueueCount() }));
  ipcMain.handle('open-dashboard', () => {
    const serverUrl = deviceAuth.metadata?.serverUrl ?? SERVER_URL;
    void shell.openExternal(`${serverUrl}/dashboard`);
    popover?.hide();
  });
  ipcMain.handle('show-panel', () => {
    // Unit 1: a persistent widget stays put — opening the panel no longer hides
    // it (the 4h popover hid because it was a transient menu).
    showWindow();
  });
  ipcMain.handle('app-quit', () => app.quit());

  // IPC: device pairing (Phase 4b). The token itself never crosses this
  // boundary — the renderer only ever sees PairState.
  ipcMain.handle('device-pair-with-code', (_e, code: unknown, label: unknown) =>
    pairWithCode(code, label),
  );
  ipcMain.handle('device-get-pair-state', () => pairStateForPanel());
  ipcMain.handle('device-unpair-local', () => {
    // Local-only: forgets the credential on this machine. Revoking the token
    // server-side is done from /settings/devices.
    deviceAuth.wipe();
    setAccount({ status: 'unpaired' }); // also pushes pair state
    clearTodayScore(); // the cached score belonged to that pairing
    return pairStateForPanel();
  });
  ipcMain.handle('device-open-pairing-page', () => {
    const serverUrl = deviceAuth.metadata?.serverUrl ?? SERVER_URL;
    void shell.openExternal(`${serverUrl}/settings/devices`);
  });

  createTray();
  // Unit 1: the Transparency panel no longer auto-opens on launch — only the
  // widget shows. The panel stays fully intact, lazily created the first time
  // its footer link fires `show-panel` (showWindow → createWindow). Show on
  // launch is fixed behavior — visibility is NOT remembered.
  showWidget();


  // (1) Sleep/wake + lock/unlock: close any open focus run and avoid forming a
  // slice across the gap. Idle detection already treats a locked screen as idle;
  // these handlers make the run-break explicit and reset the slice clock. The
  // interrupt may bank a focus block, so the snapshot is persisted too.
  powerMonitor.on('suspend', () => {
    aggregator.interrupt();
    dayStore.scheduleSave(currentPersistedState);
    lastPollAt = null;
  });
  powerMonitor.on('resume', () => {
    lastPollAt = null;
  });
  powerMonitor.on('lock-screen', () => {
    aggregator.interrupt();
    dayStore.scheduleSave(currentPersistedState);
    lastPollAt = null;
  });
  powerMonitor.on('unlock-screen', () => {
    lastPollAt = null;
  });

  void poll(); // prime lastPollAt
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  armFlushTimer();

  // Dev/smoke-test hook (env-gated, inert in normal runs): bind a global
  // shortcut that simulates a tray click (show/raise/focus), so hide→restore
  // can be exercised without clicking the real tray icon (which may sit in the
  // overflow area). The widget already shows on launch, so no auto-open timer.
  if (process.env.PULSE_DEV_OPEN_POPOVER === '1') {
    globalShortcut.register('Control+Alt+Shift+P', showWidget);
  }

  // Dev/smoke-test hook (env-gated, inert in normal runs): drive the 4i window
  // behaviors that don't require a physical mouse and print observed values.
  // Real OS-level drag + per-control mouse hit-testing (app-region) can't be
  // injected headlessly, so those stay a human check — this covers the rest.
  if (process.env.PULSE_DEV_SMOKE === '1') {
    const p = popover;
    const log = (s: string) => console.log(`SMOKE ${s}`);
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    void (async () => {
      if (!p) return log('FAIL: no widget window');
      if (p.webContents.isLoading()) await new Promise<void>((r) => p.webContents.once('did-finish-load', () => r()));
      await settle(300);
      const wa = screen.getDisplayNearestPoint(p.getBounds()).workArea;
      const b = p.getBounds();
      const fullyVisible =
        b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height;
      log(`restore: bounds=${JSON.stringify(b)} workArea=${JSON.stringify(wa)} fullyVisible=${fullyVisible}`);
      log(`flags: alwaysOnTop=${p.isAlwaysOnTop()} skipTaskbar(not-observable, set false) visible=${p.isVisible()}`);
      setWidgetPinned(true);
      log(`pin ON  -> isAlwaysOnTop=${p.isAlwaysOnTop()}`);
      setWidgetPinned(false);
      log(`pin OFF -> isAlwaysOnTop=${p.isAlwaysOnTop()}`);
      p.hide();
      await settle(150);
      log(`× hide  -> visible=${p.isVisible()} refreshTimerRunning=${widgetRefreshTimer !== null}`);
      showWidget();
      await settle(150);
      log(`tray restore -> visible=${p.isVisible()} refreshTimerRunning=${widgetRefreshTimer !== null}`);
      p.setPosition(wa.x + 60, wa.y + 60);
      persistWidgetState();
      log(`persist after move -> widget-state.json=${JSON.stringify(widgetState.load())}`);

      // Unit 2: compact pill <-> card, clamp re-runs against the NEW size.
      setWidgetCompact(true);
      await settle(120);
      log(`compact ON  -> bounds=${JSON.stringify(p.getBounds())} (pill ~${PILL_WIDTH}x${PILL_HEIGHT})`);
      // Park the pill hard in the bottom-right corner, then expand: the card is
      // far bigger, so the clamp must pull it back fully on-screen.
      p.setPosition(wa.x + wa.width - PILL_WIDTH, wa.y + wa.height - PILL_HEIGHT);
      setWidgetCompact(false);
      await settle(120);
      const cb = p.getBounds();
      const cardVisible =
        cb.x >= wa.x && cb.y >= wa.y && cb.x + cb.width <= wa.x + wa.width && cb.y + cb.height <= wa.y + wa.height;
      log(`expand from corner -> bounds=${JSON.stringify(cb)} fullyVisible=${cardVisible}`);
      log(`compact persisted=${JSON.stringify(widgetState.load())}`);

      // Unit 1: the footer "Transparency panel" link must open the panel, now
      // that it no longer auto-opens. Click the real button through the chain.
      log(`before footer click: panel win=${win ? 'exists' : 'null'}`);
      await p.webContents.executeJavaScript("document.getElementById('show-panel').click()");
      await settle(600);
      const panelUrl = win ? win.webContents.getURL() : '(none)';
      log(
        `after footer click: panel win=${win ? 'exists' : 'null'} ` +
          `visible=${win ? win.isVisible() : false} loaded=${panelUrl.split('/').pop()}`,
      );

      // Unit 3: inject one over-threshold unknown app; the nudge count reads it.
      const cls = classifier.classify('SmokeMystery');
      classifier.recordObservation(cls, 'SmokeMystery', 11);
      pushClassifyNudge();
      log(`nudge count after 1 injected over-threshold unknown = ${unknownQueueCount()}`);

      log('DONE');
      app.quit();
    })();
  }
});

// Stay alive in the tray when the window is closed.
app.on('window-all-closed', () => {
  /* tray app — do not quit */
});

// Final flush on quit so the last interval isn't lost: persist the snapshot
// first (so even a failed send loses nothing), then send the final state
// directly — the startup guard doesn't apply on the way out, and the sanity
// check still protects an immediately-quit empty session from posting zeros.
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  if (pollTimer) clearInterval(pollTimer);
  if (flushTimer) clearInterval(flushTimer);
  if (!dayStore || !aggregator) {
    app.exit(0);
    return;
  }
  dayStore.saveNow(currentPersistedState());
  void sendSummary(aggregator.buildSummary(deviceId, AGENT_VERSION)).finally(() => app.exit(0));
});
