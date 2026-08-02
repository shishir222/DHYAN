// DOM elements
const DOM = {
  timerDisplay: document.getElementById('timer-display'),
  timerPhase: document.getElementById('timer-phase'),
  timerSession: document.getElementById('timer-session'),
  timerRingProgress: document.getElementById('timer-ring-progress'),

  btnStart: document.getElementById('btn-start'),
  btnPause: document.getElementById('btn-pause'),
  btnResume: document.getElementById('btn-resume'),
  btnStop: document.getElementById('btn-stop'),

  statusIndicator: document.getElementById('status-indicator'),
  statusText: document.getElementById('status-text'),

  statFocus: document.getElementById('stat-focus'),
  statSessions: document.getElementById('stat-sessions'),
  statBlocked: document.getElementById('stat-blocked'),

  settingsToggle: document.getElementById('settings-toggle'),
  settingsPanel: document.getElementById('settings-panel'),
  settingWork: document.getElementById('setting-work'),
  settingBreak: document.getElementById('setting-break'),
  settingLongBreak: document.getElementById('setting-long-break'),
  settingSessions: document.getElementById('setting-sessions'),
  blacklistInputNew: document.getElementById('blacklist-input-new'),
  blacklistAddBtn: document.getElementById('blacklist-add-btn'),
  blacklistList: document.getElementById('blacklist-list'),
  blacklistEmptyHint: document.getElementById('blacklist-empty-hint'),
  saveSettings: document.getElementById('save-settings'),

  floatingTimerCheckbox: document.getElementById('floating-timer-checkbox'),
};

let currentState = null;
let selectedMode = 'focus';
let timerInterval = null;
let currentBlacklist = [];

const RING_CIRCUMFERENCE = 2 * Math.PI * 88;

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('sendMessage error:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

// Clean up input domain
function normalizeDomain(input) {
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '');
  domain = domain.replace(/^www\./, '');
  domain = domain.split('/')[0];
  domain = domain.split('?')[0];
  domain = domain.split('#')[0];
  domain = domain.replace(/\.+$/, '');
  return domain;
}

async function init() {
  const state = await sendMessage({ action: 'getState' });
  if (state) {
    currentState = state;
    selectedMode = state.focusMode || 'focus';
    renderFull(state);
    startTimerTick();
  }
}

function renderFull(state) {
  renderTimer(state);
  renderControls(state);
  renderStatus(state);
  renderStats(state);
  renderSettings(state);
  applyThemeClass(state);
}

function applyThemeClass(state) {
  document.body.classList.remove('mode-soft', 'mode-focus', 'mode-deep', 'phase-break');
  document.body.classList.add('mode-focus');
  if (state.sessionPhase === 'break') {
    document.body.classList.add('phase-break');
  }
}

function renderTimer(state) {
  if (state.sessionPhase === 'paused' && state.pausedTimeRemaining != null) {
    const diff = state.pausedTimeRemaining;
    DOM.timerDisplay.textContent = formatTime(diff);
    DOM.timerPhase.textContent = 'PAUSED';
    updateRing(state, diff);
  } else if (state.endTime && (state.sessionPhase === 'work' || state.sessionPhase === 'break')) {
    const diff = Math.max(0, state.endTime - Date.now());
    DOM.timerDisplay.textContent = formatTime(diff);
    DOM.timerPhase.textContent = state.sessionPhase === 'work' ? 'FOCUS' : 'BREAK';
    updateRing(state, diff);
  } else {
    const workMin = state.workDuration || 25;
    DOM.timerDisplay.textContent = `${String(workMin).padStart(2, '0')}:00`;
    DOM.timerPhase.textContent = 'READY';
    DOM.timerRingProgress.style.strokeDashoffset = RING_CIRCUMFERENCE;
  }

  const total = state.sessionsBeforeLongBreak || 4;
  const current = state.currentSessionCount || 0;
  DOM.timerSession.textContent = `Session ${current} / ${total}`;
}

function updateRing(state, remainingMs) {
  const totalMs = getTotalPhaseDuration(state);
  if (totalMs <= 0) return;

  const elapsed = totalMs - remainingMs;
  const progress = Math.min(1, elapsed / totalMs);
  const offset = RING_CIRCUMFERENCE * (1 - progress);
  DOM.timerRingProgress.style.strokeDashoffset = offset;
}

function getTotalPhaseDuration(state) {
  if (state.sessionPhase === 'work') {
    return (state.workDuration || 25) * 60 * 1000;
  } else if (state.sessionPhase === 'break') {
    const count = state.currentSessionCount || 0;
    const longEvery = state.sessionsBeforeLongBreak || 4;
    if (count > 0 && count % longEvery === 0) {
      return (state.longBreakDuration || 15) * 60 * 1000;
    }
    return (state.breakDuration || 5) * 60 * 1000;
  } else if (state.sessionPhase === 'paused') {
    if (state.pausedPhase === 'work') return (state.workDuration || 25) * 60 * 1000;
    if (state.pausedPhase === 'break') return (state.breakDuration || 5) * 60 * 1000;
  }
  return (state.workDuration || 25) * 60 * 1000;
}

function renderControls(state) {
  const { sessionActive, sessionPhase } = state;

  if (!sessionActive || sessionPhase === 'idle') {
    show(DOM.btnStart);
    hide(DOM.btnPause);
    hide(DOM.btnResume);
    hide(DOM.btnStop);
  } else if (sessionPhase === 'paused') {
    hide(DOM.btnStart);
    hide(DOM.btnPause);
    show(DOM.btnResume);
    show(DOM.btnStop);
  } else {
    hide(DOM.btnStart);
    show(DOM.btnPause);
    hide(DOM.btnResume);
    show(DOM.btnStop);
  }
}

function renderStatus(state) {
  const { sessionActive, sessionPhase, focusMode } = state;

  DOM.statusIndicator.classList.remove('active', 'paused');

  if (!sessionActive) {
    DOM.statusText.textContent = 'Ready to focus';
  } else if (sessionPhase === 'paused') {
    DOM.statusIndicator.classList.add('paused');
    DOM.statusText.textContent = 'Session paused';
  } else if (sessionPhase === 'work') {
    DOM.statusIndicator.classList.add('active');
    const modeLabel = focusMode === 'deep' ? 'Deep Lock' : focusMode === 'soft' ? 'Soft Focus' : 'Focus Session';
    DOM.statusText.textContent = `${modeLabel} — working`;
  } else if (sessionPhase === 'break') {
    DOM.statusIndicator.classList.add('active');
    DOM.statusText.textContent = 'Break time — relax';
  }
}

function renderStats(state) {
  const stats = state.stats || {};
  const totalMs = stats.totalFocusMs || 0;
  const hours = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);

  DOM.statFocus.textContent = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  DOM.statSessions.textContent = stats.sessionsCompleted || 0;
  DOM.statBlocked.textContent = stats.distractionsBlocked || 0;
}

function renderSettings(state) {
  DOM.settingWork.textContent = state.workDuration || 25;
  DOM.settingBreak.textContent = state.breakDuration || 5;
  DOM.settingLongBreak.textContent = state.longBreakDuration || 15;
  DOM.settingSessions.textContent = state.sessionsBeforeLongBreak || 4;
  DOM.floatingTimerCheckbox.checked = state.showFloatingTimer !== false;

  currentBlacklist = state.blacklist ? [...state.blacklist] : [];
  renderBlacklist();
}

function renderBlacklist() {
  DOM.blacklistList.innerHTML = '';

  if (DOM.blacklistEmptyHint) {
    DOM.blacklistEmptyHint.style.display = currentBlacklist.length === 0 ? 'block' : 'none';
  }

  currentBlacklist.forEach((domain, index) => {
    const li = document.createElement('li');
    li.className = 'blacklist-item';

    const domainSpan = document.createElement('span');
    domainSpan.className = 'blacklist-domain';
    domainSpan.textContent = domain;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'blacklist-delete';
    deleteBtn.title = 'Remove';
    deleteBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    `;
    deleteBtn.onclick = () => removeBlacklistItem(index);

    li.appendChild(domainSpan);
    li.appendChild(deleteBtn);
    DOM.blacklistList.appendChild(li);
  });
}

async function addBlacklistItem() {
  const raw = DOM.blacklistInputNew.value;
  const domain = normalizeDomain(raw);

  if (!domain) return;
  if (currentBlacklist.includes(domain)) {
    DOM.blacklistInputNew.value = '';
    return;
  }

  currentBlacklist.push(domain);
  DOM.blacklistInputNew.value = '';
  renderBlacklist();
  await saveBlacklist();
}

async function removeBlacklistItem(index) {
  currentBlacklist.splice(index, 1);
  renderBlacklist();
  await saveBlacklist();
}

async function saveBlacklist() {
  const state = await sendMessage({
    action: 'updateSettings',
    blacklist: currentBlacklist,
  });
  if (state && !state.error) {
    currentState = state;
  }
}

function startTimerTick() {
  clearInterval(timerInterval);
  timerInterval = setInterval(async () => {
    if (!currentState) return;

    const { sessionActive, sessionPhase, endTime } = currentState;

    if (sessionActive && (sessionPhase === 'work' || sessionPhase === 'break') && endTime) {
      const diff = Math.max(0, endTime - Date.now());
      DOM.timerDisplay.textContent = formatTime(diff);
      updateRing(currentState, diff);

      if (diff <= 0) {
        const state = await sendMessage({ action: 'getState' });
        if (state) {
          currentState = state;
          renderFull(state);
        }
      }
    }
  }, 250);
}

DOM.btnStart.addEventListener('click', async () => {
  const state = await sendMessage({ action: 'startSession', mode: selectedMode });
  if (state && !state.error) {
    currentState = state;
    renderFull(state);
  }
});

DOM.btnPause.addEventListener('click', async () => {
  const state = await sendMessage({ action: 'pauseSession' });
  if (state && !state.error) {
    currentState = state;
    renderFull(state);
  }
});

DOM.btnResume.addEventListener('click', async () => {
  const state = await sendMessage({ action: 'resumeSession' });
  if (state && !state.error) {
    currentState = state;
    renderFull(state);
  }
});

DOM.btnStop.addEventListener('click', async () => {
  const state = await sendMessage({ action: 'stopSession' });
  if (state && !state.error) {
    currentState = state;
    renderFull(state);
  }
});

DOM.settingsToggle.addEventListener('click', () => {
  const panel = DOM.settingsPanel;
  const isHidden = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  DOM.settingsToggle.classList.toggle('active', isHidden);
});

document.querySelectorAll('.setting-adj').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (currentState && currentState.sessionActive) return;

    const targetId = btn.dataset.target;
    const delta = parseInt(btn.dataset.delta, 10);
    const el = document.getElementById(targetId);
    let val = parseInt(el.textContent, 10) + delta;

    if (targetId === 'setting-work') val = Math.max(1, Math.min(120, val));
    if (targetId === 'setting-break') val = Math.max(1, Math.min(30, val));
    if (targetId === 'setting-long-break') val = Math.max(5, Math.min(60, val));
    if (targetId === 'setting-sessions') val = Math.max(1, Math.min(10, val));

    el.textContent = val;
  });
});

DOM.blacklistAddBtn.addEventListener('click', addBlacklistItem);
DOM.blacklistInputNew.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addBlacklistItem();
});

DOM.floatingTimerCheckbox.addEventListener('change', async () => {
  const value = DOM.floatingTimerCheckbox.checked;
  const state = await sendMessage({ action: 'updateShowFloatingTimer', value });
  if (state && !state.error) {
    currentState = state;
  }
});

DOM.saveSettings.addEventListener('click', async () => {
  const workDuration = parseInt(DOM.settingWork.textContent, 10);
  const breakDuration = parseInt(DOM.settingBreak.textContent, 10);
  const longBreakDuration = parseInt(DOM.settingLongBreak.textContent, 10);
  const sessionsBeforeLongBreak = parseInt(DOM.settingSessions.textContent, 10);
  const blacklist = currentBlacklist;

  const state = await sendMessage({
    action: 'updateSettings',
    workDuration,
    breakDuration,
    longBreakDuration,
    sessionsBeforeLongBreak,
    blacklist,
  });

  if (state && !state.error) {
    currentState = state;
    renderFull(state);
    DOM.saveSettings.textContent = 'Saved ✓';
    setTimeout(() => { DOM.saveSettings.textContent = 'Save Settings'; }, 1200);
  }
});

function formatTime(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function handleNotify() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('notify') === 'true') {
    setTimeout(() => {
      window.close();
    }, 5000);
  }
}

handleNotify();
init();