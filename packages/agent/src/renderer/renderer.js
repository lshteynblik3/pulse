// Minimal renderer. `window.pulse` is exposed by preload.ts.
const appEl = document.getElementById('app');
const toggleEl = document.getElementById('private-toggle');
const pausedHintEl = document.getElementById('paused-hint');

const unknownListEl = document.getElementById('unknown-list');
const unknownEmptyEl = document.getElementById('unknown-empty');
const seenListEl = document.getElementById('seen-list');
const seenEmptyEl = document.getElementById('seen-empty');

const flushBtn = document.getElementById('flush-btn');
const flushLastEl = document.getElementById('flush-last');
const flushMsgEl = document.getElementById('flush-msg');

let lastFlushAt = null;
let flushMsgTimer = null;

// Categories a user can assign. 'other' is included so you can also push a
// wrongly-guessed app (e.g. a chat app you only use socially) out of focus.
const ASSIGNABLE = [
  'development',
  'communication',
  'creative',
  'admin',
  'browser',
  'entertainment',
  'other',
];

function render(status) {
  appEl.textContent = status.app;
  appEl.classList.toggle('status-paused', status.paused);
  toggleEl.checked = status.paused;
  pausedHintEl.style.display = status.paused ? 'block' : 'none';
}

// Build the row of category buttons for one app; clicking sends the override.
function categoryButtons(app) {
  const wrap = document.createElement('div');
  wrap.className = 'cat-btns';
  for (const category of ASSIGNABLE) {
    const btn = document.createElement('button');
    btn.textContent = category;
    if (app.category === category) btn.classList.add('active');
    btn.addEventListener('click', () => {
      window.pulse.classifyApp(app.normalized, category).then(renderClassifier);
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

function appRow(app, { showCurrent }) {
  const li = document.createElement('li');
  li.className = 'app-row';
  // In "recently tracked", an unclassified app is shown (no blind spot) but
  // visually marked. The 10-min queue above stays the "classify these now" ask.
  const markUnknown = showCurrent && app.category === 'unknown';
  if (markUnknown) li.classList.add('unclassified');

  const name = document.createElement('div');
  name.className = 'app-name';
  name.textContent = app.displayName;
  if (markUnknown) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = 'needs classification';
    name.appendChild(pill);
  }
  li.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'app-meta';
  const mins = `${Math.round(app.minutesToday)} min today`;
  meta.textContent =
    showCurrent && !markUnknown ? `${app.category} · ${app.source} · ${mins}` : mins;
  li.appendChild(meta);

  li.appendChild(categoryButtons(app));
  return li;
}

function renderClassifier(state) {
  const unknown = state.unknownQueue ?? [];
  const seen = state.seen ?? [];

  unknownEmptyEl.style.display = unknown.length ? 'none' : 'block';
  unknownListEl.replaceChildren(...unknown.map((a) => appRow(a, { showCurrent: false })));

  seenEmptyEl.style.display = seen.length ? 'none' : 'block';
  seenListEl.replaceChildren(...seen.map((a) => appRow(a, { showCurrent: true })));
}

// --- Manual flush ---------------------------------------------------------

function relativeTime(ms) {
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs} seconds ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
}

function renderFlushLast() {
  flushLastEl.textContent = lastFlushAt
    ? `Last flushed: ${relativeTime(lastFlushAt)}`
    : 'Last flushed: never';
}

function showFlushMsg(text, kind) {
  flushMsgEl.textContent = text;
  flushMsgEl.className = `flush-msg ${kind}`;
  if (flushMsgTimer) clearTimeout(flushMsgTimer);
  flushMsgTimer = setTimeout(() => {
    flushMsgEl.textContent = '';
    flushMsgEl.className = 'flush-msg';
  }, 4000);
}

flushBtn.addEventListener('click', () => {
  // Disable for ~2s so a rapid second click is dropped (no double flush).
  flushBtn.disabled = true;
  flushMsgEl.textContent = '';
  flushMsgEl.className = 'flush-msg';

  window.pulse
    .flushNow()
    .then((result) => {
      if (result.ok) {
        lastFlushAt = result.at;
        renderFlushLast();
        showFlushMsg(`Flushed at ${new Date(result.at).toLocaleTimeString()}`, 'ok');
      } else if (result.notReady) {
        // Startup guard, not a failure — e.g. "Flush available in 42s".
        showFlushMsg(result.error || 'Not ready to flush yet.', 'info');
      } else {
        showFlushMsg(`Flush failed: ${result.error || 'unknown error'}`, 'err');
      }
    })
    .catch((err) => {
      showFlushMsg(`Flush failed: ${err && err.message ? err.message : 'unknown error'}`, 'err');
    });

  setTimeout(() => {
    flushBtn.disabled = false;
  }, 2000);
});

// React to live updates from the main process.
window.pulse.onStatus(render);
window.pulse.onClassifierState(renderClassifier);
window.pulse.onFlushState((state) => {
  lastFlushAt = state.lastFlushAt;
  renderFlushLast();
});

// Initial state on load.
window.pulse.getStatus().then(render);
window.pulse.getClassifierState().then(renderClassifier);
window.pulse.getFlushState().then((state) => {
  lastFlushAt = state.lastFlushAt;
  renderFlushLast();
});

// Keep the "Last flushed" relative time fresh without a server round-trip.
setInterval(renderFlushLast, 20000);

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
