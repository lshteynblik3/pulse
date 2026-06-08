import { contextBridge, ipcRenderer } from 'electron';

// Expose a tiny, safe API to the renderer (no Node access in the page itself).
contextBridge.exposeInMainWorld('pulse', {
  /** Subscribe to "currently tracked app" updates. Returns an unsubscribe fn. */
  onTrackedApp(callback: (name: string) => void): () => void {
    const listener = (_event: unknown, name: string) => callback(name);
    ipcRenderer.on('tracked-app', listener);
    return () => ipcRenderer.removeListener('tracked-app', listener);
  },
});
