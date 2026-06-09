// Minimal renderer. `window.pulse` is exposed by preload.ts.
const appEl = document.getElementById('app');
const toggleEl = document.getElementById('private-toggle');
const pausedHintEl = document.getElementById('paused-hint');

function render(status) {
  appEl.textContent = status.app;
  appEl.classList.toggle('status-paused', status.paused);
  toggleEl.checked = status.paused;
  pausedHintEl.style.display = status.paused ? 'block' : 'none';
}

// React to live updates from the main process.
window.pulse.onStatus(render);

// Initial state on load.
window.pulse.getStatus().then(render);

// Toggle "mark private".
toggleEl.addEventListener('change', () => {
  window.pulse.setPaused(toggleEl.checked).then((paused) => {
    render({ paused, app: paused ? 'paused (private)' : appEl.textContent });
  });
});
