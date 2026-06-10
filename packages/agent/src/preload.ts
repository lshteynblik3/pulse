import { contextBridge, ipcRenderer } from 'electron';

type Status = { paused: boolean; app: string };
type PairState = { paired: boolean; label?: string; pairedAt?: string; defaultLabel: string };
type PairResult = { ok: true } | { ok: false; error: string };

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
