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

// --- Device pairing (Phase 4b) ---

const pairedEl = document.getElementById('pair-paired');
const unpairedEl = document.getElementById('pair-unpaired');
const pairLabelEl = document.getElementById('pair-label');
const codeEl = document.getElementById('pair-code');
const deviceLabelEl = document.getElementById('pair-device-label');
const pairBtn = document.getElementById('pair-btn');
const pairResultEl = document.getElementById('pair-result');

function renderPairState(state) {
  pairedEl.style.display = state.paired ? 'block' : 'none';
  unpairedEl.style.display = state.paired ? 'none' : 'block';
  if (state.paired) {
    pairLabelEl.textContent = state.label;
    pairResultEl.textContent = '';
  } else {
    // Default the label to the hostname (sent over from the main process —
    // the renderer has no Node access).
    if (!deviceLabelEl.value) deviceLabelEl.placeholder = state.defaultLabel;
  }
}

window.pulse.onPairState(renderPairState);
window.pulse.getPairState().then(renderPairState);

// Auto-uppercase + strip whitespace as the user types, mirroring what the
// agent and server do to the code anyway.
codeEl.addEventListener('input', () => {
  codeEl.value = codeEl.value.replace(/\s+/g, '').toUpperCase();
});

pairBtn.addEventListener('click', () => {
  pairBtn.disabled = true;
  pairResultEl.textContent = 'Pairing…';
  pairResultEl.className = 'hint';
  window.pulse
    .pairWithCode(codeEl.value, deviceLabelEl.value || deviceLabelEl.placeholder)
    .then((result) => {
      if (result.ok) {
        // renderPairState flips the section via the pushed pair-state event;
        // just clear the inputs for next time.
        codeEl.value = '';
        pairResultEl.textContent = '';
      } else {
        pairResultEl.textContent = result.error;
        pairResultEl.className = 'hint pair-error';
      }
    })
    .finally(() => {
      pairBtn.disabled = false;
    });
});

document.getElementById('open-pairing-page').addEventListener('click', () => {
  window.pulse.openPairingPage();
});

document.getElementById('unpair-btn').addEventListener('click', () => {
  window.pulse.unpairLocal().then(renderPairState);
});
