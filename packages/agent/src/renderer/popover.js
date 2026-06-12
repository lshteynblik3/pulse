// Popover renderer (4h). Displays ONLY what the main process hands over —
// the score and coach message arrive server-computed; nothing is calculated
// here beyond presentation (colors, relative times, arc length).

const gaugeValueEl = document.getElementById('gauge-value');
const scoreEl = document.getElementById('score');
const scoreLabelEl = document.getElementById('score-label');
const coachEl = document.getElementById('coach');
const freshnessEl = document.getElementById('freshness');
const identityEl = document.getElementById('identity');
const statusDotEl = document.getElementById('status-dot');
const statusTextEl = document.getElementById('status-text');
const toggleEl = document.getElementById('private-toggle');
const flushLastEl = document.getElementById('flush-last');
const flushMsgEl = document.getElementById('flush-msg');
const flushBtn = document.getElementById('flush-btn');

const GAUGE_C = 2 * Math.PI * 84; // matches the SVG's r=84
const GAUGE_ARC = GAUGE_C * 0.75; // 270° sweep, same treatment as the dashboard

let today = null; // TodayScore | null
let lastFlushAt = null;
let flushMsgTimer = null;
let everLoaded = false;

// Presentational only — the same band → color mapping the dashboard uses
// (web/src/lib/dashboard/format.ts scoreColor). Copy (the message) is NOT
// duplicated: it arrives from the server.
function scoreColor(score) {
  if (score >= 80) return '#1a7f37';
  if (score >= 60) return '#6d4fe5';
  if (score >= 40) return '#8d77e0';
  return '#64748b';
}

function relativeTime(ms) {
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** The agent's local civil day — same components-only construction as everywhere. */
function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function renderScore() {
  // A cached score from a previous day is not "today" — treat as no data
  // while the refresh (fired on every open) catches up.
  const current = today && today.date === localToday() ? today : null;

  if (current && current.score !== null) {
    const color = scoreColor(current.score);
    scoreEl.textContent = String(current.score);
    scoreEl.style.color = color;
    scoreLabelEl.textContent = 'focus score';
    gaugeValueEl.setAttribute('stroke', color);
    const filled = (Math.max(0, Math.min(100, current.score)) / 100) * GAUGE_ARC;
    gaugeValueEl.setAttribute('stroke-dasharray', `${filled} ${GAUGE_C}`);
    coachEl.textContent = current.message || '';
    coachEl.className = 'coach';
  } else {
    scoreEl.textContent = '–';
    scoreEl.style.color = '#6f6b7a';
    scoreLabelEl.textContent = 'focus score';
    gaugeValueEl.setAttribute('stroke-dasharray', `0 ${GAUGE_C}`);
    coachEl.className = 'coach empty';
    coachEl.textContent = current
      ? 'No data yet today — your score lands here once the agent posts.'
      : everLoaded
        ? 'No data yet today — your score lands here once the agent posts.'
        : 'Checking today…';
  }

  freshnessEl.textContent = today ? `updated ${relativeTime(today.fetchedAt)}` : '';
}

function renderIdentity(state) {
  const account = state && state.account;
  identityEl.className = 'identity';
  if (!state || !state.paired) {
    identityEl.textContent = 'Not paired';
    identityEl.className = 'identity warn';
    return;
  }
  if (!account) {
    identityEl.textContent = state.label || 'Paired';
    return;
  }
  switch (account.status) {
    case 'ok':
      identityEl.textContent = account.displayName || account.email;
      identityEl.title = account.email;
      break;
    case 'checking':
      identityEl.textContent = '(checking…)';
      break;
    case 'invalid':
      identityEl.textContent = 'Pairing invalid — re-pair in Settings';
      identityEl.className = 'identity warn';
      break;
    default:
      identityEl.textContent = state.label || 'Paired';
  }
}

function renderStatus(status) {
  statusDotEl.className = status.paused ? 'dot paused' : 'dot';
  statusTextEl.textContent = status.paused ? 'Paused (private)' : 'Tracking';
  toggleEl.checked = status.paused;
}

function renderFlushLast() {
  flushLastEl.textContent = lastFlushAt
    ? `Last flushed ${relativeTime(lastFlushAt)}`
    : 'Last flushed: never';
}

function showFlushMsg(text, kind) {
  flushMsgEl.textContent = ` · ${text}`;
  flushMsgEl.className = `flush-msg ${kind}`;
  if (flushMsgTimer) clearTimeout(flushMsgTimer);
  flushMsgTimer = setTimeout(() => {
    flushMsgEl.textContent = '';
    flushMsgEl.className = 'flush-msg';
  }, 4000);
}

// --- Wiring ---------------------------------------------------------------

window.pulse.onTodayScore((score) => {
  today = score;
  everLoaded = true;
  renderScore();
});
window.pulse.onStatus(renderStatus);
window.pulse.onPairState(renderIdentity);
window.pulse.onFlushState((state) => {
  lastFlushAt = state.lastFlushAt;
  renderFlushLast();
});

window.pulse.getTodayScore().then((score) => {
  today = score;
  if (score) everLoaded = true;
  renderScore();
});
window.pulse.getStatus().then(renderStatus);
window.pulse.getPairState().then(renderIdentity);
window.pulse.getFlushState().then((state) => {
  lastFlushAt = state.lastFlushAt;
  renderFlushLast();
});

// Relative times ("updated 3m ago", "last flushed 12m ago") stay honest while
// the popover sits open.
setInterval(() => {
  renderScore();
  renderFlushLast();
}, 20000);

toggleEl.addEventListener('change', () => {
  window.pulse.setPaused(toggleEl.checked).then((paused) => {
    renderStatus({ paused, app: '' });
  });
});

flushBtn.addEventListener('click', () => {
  flushBtn.disabled = true; // 2s guard, same as the panel; main has the real one
  window.pulse
    .flushNow()
    .then((result) => {
      if (result.ok) {
        lastFlushAt = result.at;
        renderFlushLast();
        showFlushMsg('flushed ✓', 'ok');
      } else if (result.notReady) {
        showFlushMsg(result.error || 'not ready yet', 'info');
      } else {
        showFlushMsg(result.error || 'flush failed', 'err');
      }
    })
    .catch(() => showFlushMsg('flush failed', 'err'));
  setTimeout(() => {
    flushBtn.disabled = false;
  }, 2000);
});

document.getElementById('open-dashboard').addEventListener('click', () => {
  window.pulse.openDashboard();
});
document.getElementById('show-panel').addEventListener('click', () => {
  window.pulse.showPanel();
});
document.getElementById('quit').addEventListener('click', () => {
  window.pulse.quitApp();
});

// Esc dismisses — the popover must never trap focus.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.pulse.hidePopover();
});
