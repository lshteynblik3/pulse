import { contextBridge, ipcRenderer } from 'electron';

type Status = { paused: boolean; app: string };
type AccountIdentity =
  | { status: 'unpaired' }
  | { status: 'checking' }
  | { status: 'ok'; email: string; displayName: string | null }
  | { status: 'invalid' }
  | { status: 'error' };
type PairState = {
  paired: boolean;
  label?: string;
  pairedAt?: string;
  defaultLabel: string;
  account: AccountIdentity;
};
type PairResult = { ok: true } | { ok: false; error: string };

type SeenApp = {
  normalized: string;
  displayName: string;
  category: string;
  source: string;
  minutesToday: number;
};
type ClassifierState = { seen: SeenApp[]; unknownQueue: SeenApp[] };

type FlushResult = { ok: boolean; at: number; error?: string; notReady?: boolean };
type FlushState = { lastFlushAt: number | null };

/** Server-computed; the renderer only displays it. Null = nothing cached yet. */
type TodayScore = {
  date: string;
  score: number | null;
  message: string | null;
  lastActivityAt: string | null;
  fetchedAt: number;
} | null;

// Expose a tiny, safe API to the renderer (no Node access in the page itself).
// The device token NEVER crosses this bridge — only PairState does.
contextBridge.exposeInMainWorld('pulse', {
  /** Subscribe to status updates (tracked app + paused). Returns an unsubscribe fn. */
  onStatus(callback: (status: Status) => void): () => void {
    const listener = (_event: unknown, status: Status) => callback(status);
    ipcRenderer.on('status', listener);
    return () => ipcRenderer.removeListener('status', listener);
  },
  /** Fetch the current status once (e.g. on load). */
  getStatus(): Promise<Status> {
    return ipcRenderer.invoke('get-status');
  },
  /** Turn "mark private" on/off. Resolves to the new paused value. */
  setPaused(value: boolean): Promise<boolean> {
    return ipcRenderer.invoke('set-paused', value);
  },

  /** Subscribe to classifier-state updates (seen apps + unknown queue). */
  onClassifierState(callback: (state: ClassifierState) => void): () => void {
    const listener = (_event: unknown, state: ClassifierState) => callback(state);
    ipcRenderer.on('classifier-state', listener);
    return () => ipcRenderer.removeListener('classifier-state', listener);
  },
  /** Fetch the classifier state once (e.g. on load). */
  getClassifierState(): Promise<ClassifierState> {
    return ipcRenderer.invoke('get-classifier-state');
  },
  /** Classify/reclassify an app by its normalized name. Resolves to the new state. */
  classifyApp(normalized: string, category: string): Promise<ClassifierState> {
    return ipcRenderer.invoke('classify-app', { normalized, category });
  },

  /** Trigger an immediate flush. Resolves to the outcome (ok / error). */
  flushNow(): Promise<FlushResult> {
    return ipcRenderer.invoke('flush-now');
  },
  /** Fetch the last-flush timestamp once (e.g. on load). */
  getFlushState(): Promise<FlushState> {
    return ipcRenderer.invoke('get-flush-state');
  },
  /** Subscribe to last-flush-timestamp updates. Returns an unsubscribe fn. */
  onFlushState(callback: (state: FlushState) => void): () => void {
    const listener = (_event: unknown, state: FlushState) => callback(state);
    ipcRenderer.on('flush-state', listener);
    return () => ipcRenderer.removeListener('flush-state', listener);
  },

  // --- Tray popover (Phase 4h) ---

  /** Fetch the cached server-computed score once (popover load). */
  getTodayScore(): Promise<TodayScore> {
    return ipcRenderer.invoke('get-today-score');
  },
  /** Subscribe to score updates (background refresh landing). */
  onTodayScore(callback: (score: TodayScore) => void): () => void {
    const listener = (_event: unknown, score: TodayScore) => callback(score);
    ipcRenderer.on('today-score', listener);
    return () => ipcRenderer.removeListener('today-score', listener);
  },
  /** Hide the popover (Esc key). */
  hidePopover(): Promise<void> {
    return ipcRenderer.invoke('popover-hide');
  },
  /** Open the web dashboard in the default browser (never an embedded view). */
  openDashboard(): Promise<void> {
    return ipcRenderer.invoke('open-dashboard');
  },
  /** Open the Transparency panel window (the popover replaced the menu entry). */
  showPanel(): Promise<void> {
    return ipcRenderer.invoke('show-panel');
  },
  /** Quit the agent (runs the final flush on the way out). */
  quitApp(): Promise<void> {
    return ipcRenderer.invoke('app-quit');
  },

  // --- Device pairing (Phase 4b) ---

  /** Subscribe to pairing-state changes (pair, unpair, 401 self-unpair). */
  onPairState(callback: (state: PairState) => void): () => void {
    const listener = (_event: unknown, state: PairState) => callback(state);
    ipcRenderer.on('pair-state', listener);
    return () => ipcRenderer.removeListener('pair-state', listener);
  },
  /** Fetch the pairing state once (e.g. on load). */
  getPairState(): Promise<PairState> {
    return ipcRenderer.invoke('device-get-pair-state');
  },
  /** Trade a pairing code from /settings/devices for this device's token. */
  pairWithCode(code: string, label: string): Promise<PairResult> {
    return ipcRenderer.invoke('device-pair-with-code', code, label);
  },
  /** Forget the credential on this machine only (revocation lives on the web). */
  unpairLocal(): Promise<PairState> {
    return ipcRenderer.invoke('device-unpair-local');
  },
  /** Open the web app's /settings/devices page in the default browser. */
  openPairingPage(): Promise<void> {
    return ipcRenderer.invoke('device-open-pairing-page');
  },
});
