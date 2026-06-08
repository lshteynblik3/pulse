// Minimal renderer script. `window.pulse` is exposed by preload.ts.
window.pulse.onTrackedApp((name) => {
  document.getElementById('app').textContent = name;
});
