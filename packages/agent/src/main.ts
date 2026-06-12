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
let popover: BrowserWindow | null = null;
/** When the popover last hid — lets a tray click that blurred it not instantly reopen it. */
let popoverHiddenAt = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

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

/** Push classifier state to the renderer, but only when it actually changed. */
function pushClassifierStateIfChanged(): void {
  if (classifier.revision === lastPushedClassifierRev) return;
  lastPushedClassifierRev = classifier.revision;
  win?.webContents.send('classifier-state', classifier.getState());
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
      message?: unknown;
      lastActivityAt?: unknown;
    };
    if (
      typeof body.date !== 'string' ||
      (body.score !== null && typeof body.score !== 'number') ||
      (body.message !== null && typeof body.message !== 'string') ||
      (body.lastActivityAt !== null && typeof body.lastActivityAt !== 'string')
    ) {
      throw new Error('agent/today response was malformed');
    }
    todayScore = {
      date: body.date,
      score: body.score as number | null,
      message: body.message as string | null,
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
// Tray popover (4h): a frameless card replacing the native context menu.
// Same creation/preload/IPC pattern as the Transparency panel — second
// renderer page, same contextBridge API, handlers registered before windows.
// ---------------------------------------------------------------------------

const POPOVER_WIDTH = 340;
const POPOVER_HEIGHT = 442;

function createPopover(): void {
  popover = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    show: false,
    frame: false,
    transparent: true, // the card's rounded corners need a transparent backing
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
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
  });
  // Clicking anywhere else dismisses it — the menu-bar-app contract. The
  // window is hidden, not destroyed, so reopening is instant.
  popover.on('blur', () => popover?.hide());
  popover.on('hide', () => {
    popoverHiddenAt = Date.now();
  });
  popover.on('closed', () => {
    popover = null;
  });
}

/** Place the popover near the tray icon, clamped inside the display's work area. */
function showPopover(): void {
  if (!popover) createPopover();
  const p = popover;
  if (!p) return;

  const trayBounds = tray?.getBounds();
  const anchor =
    trayBounds && trayBounds.width > 0
      ? { x: trayBounds.x + Math.round(trayBounds.width / 2), y: trayBounds.y }
      : screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(anchor).workArea;

  // Centered on the icon, opening AWAY from the taskbar edge (above a bottom
  // bar, below a top bar), then clamped so it never hangs off-screen.
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const openUp = anchor.y > wa.y + wa.height / 2;
  const x = clamp(anchor.x - Math.round(POPOVER_WIDTH / 2), wa.x + 8, wa.x + wa.width - POPOVER_WIDTH - 8);
  const y = clamp(
    openUp ? anchor.y - POPOVER_HEIGHT - 10 : anchor.y + 18,
    wa.y + 8,
    wa.y + wa.height - POPOVER_HEIGHT - 8,
  );

  p.setPosition(x, y);
  if (process.env.PULSE_DEV_OPEN_POPOVER === '1') {
    const d = screen.getDisplayNearestPoint(anchor);
    console.log(
      `popover: tray=${JSON.stringify(trayBounds)} wa=${JSON.stringify(wa)} pos=${x},${y} ` +
        `actual=${JSON.stringify(p.getBounds())} display=${JSON.stringify(d.bounds)} scale=${d.scaleFactor}`,
    );
  }
  // First-ever open: the page may still be loading, and showing a transparent
  // window pre-paint reads as a blank flash. Defer that one show to the load.
  if (p.webContents.isLoading()) {
    p.webContents.once('did-finish-load', () => {
      p.show();
      p.focus();
    });
  } else {
    p.show();
    p.focus();
  }
  // Cached value is already on screen — refresh behind it.
  void refreshTodayScore();
}

function togglePopover(): void {
  if (popover?.isVisible()) {
    popover.hide();
    return;
  }
  // A tray click while open fires blur (hide) BEFORE this handler — without
  // this guard the same click would instantly reopen it and the toggle would
  // never close. 300ms is well under a deliberate second click.
  if (Date.now() - popoverHiddenAt < 300) return;
  showPopover();
}

function createTray(): void {
  tray = new Tray(makeTrayIcon());
  // No native context menu (4h): the popover IS the menu now.
  tray.on('click', togglePopover);
  tray.on('right-click', togglePopover);
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
    return classifier.getState();
  });

  // Manual flush: same path as the scheduled flush, resets the schedule.
  ipcMain.handle('flush-now', () => flushNow());
  ipcMain.handle('get-flush-state', () => ({ lastFlushAt }));

  // Popover (4h). The score is server-computed and cached; the renderer only
  // ever sees the finished TodayScore.
  ipcMain.handle('get-today-score', () => todayScore);
  ipcMain.handle('popover-hide', () => popover?.hide());
  ipcMain.handle('open-dashboard', () => {
    const serverUrl = deviceAuth.metadata?.serverUrl ?? SERVER_URL;
    void shell.openExternal(`${serverUrl}/dashboard`);
    popover?.hide();
  });
  ipcMain.handle('show-panel', () => {
    popover?.hide();
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
  createWindow();


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

  // Dev/smoke-test hook (env-gated, inert in normal runs): auto-open the
  // popover and bind a global toggle so dismiss/reopen can be exercised
  // without clicking the real tray icon (which may sit in the overflow area).
  if (process.env.PULSE_DEV_OPEN_POPOVER === '1') {
    globalShortcut.register('Control+Alt+Shift+P', togglePopover);
    setTimeout(showPopover, 1200);
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
