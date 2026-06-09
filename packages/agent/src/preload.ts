import { contextBridge, ipcRenderer } from 'electron';

type Status = { paused: boolean; app: string };

// Expose a tiny, safe API to the renderer (no Node access in the page itself).
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
});
