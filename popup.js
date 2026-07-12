/**
 * Focus Lock Pro — Popup Controller (v2.0)
 *
 * Pure UI logic. Zero enforcement.
 * All state reads/writes go through chrome.runtime.sendMessage to the background.
 */

// DOM References

const DOM = {

  // Timer
  timerDisplay: document.getElementById('timer-display'),
  timerPhase: document.getElementById('timer-phase'),
  timerSession: document.getElementById('timer-session'),
  timerRingProgress: document.getElementById('timer-ring-progress'),

  // Controls
  btnStart: document.getElementById('btn-start'),
  btnPause: document.getElementById('btn-pause'),
  btnResume: document.getElementById('btn-resume'),
  btnStop: document.getElementById('btn-stop'),

  // Status
  statusIndicator: document.getElementById('status-indicator'),
  statusText: document.getElementById('status-text'),

  // Stats
  statFocus: document.getElementById('stat-focus'),
  statSessions: document.getElementById('stat-sessions'),
  statBlocked: document.getElementById('stat-blocked'),

  // Settings
  settingsToggle: document.getElementById('settings-toggle'),
  settingsPanel: document.getElementById('settings-panel'),
  settingWork: document.getElementById('setting-work'),
  settingBreak: document.getElementById('setting-break'),
  settingLongBreak: document.getElementById('setting-long-break'),
  settingSessions: document.getElementById('setting-sessions'),
  whitelistInputNew: document.getElementById('blacklist-input-new'),
  whitelistAddBtn: document.getElementById('blacklist-add-btn'),
  whitelistList: document.getElementById('blacklist-list'),
  saveSettings: document.getElementById('save-settings'),
};

// State variables

let currentState = null;
let selectedMode = 'focus';
let timerInterval = null;
let currentBlacklist = [];

// Ring circumference: 2 * π * 88
const RING_CIRCUMFERENCE = 2 * Math.PI * 88;

// Messaging helper

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

// Initialization

async function init() {
  const state = await sendMessage({ action: 'getState' });
  if (state) {
    currentState = state;
    selectedMode = state.focusMode || 'focus';
    renderFull(state);
    startTimerTick();
  }
}

// Rendering functions

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
    // Show frozen time during pause
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
    const mode = state.sessionActive ? state.focusMode : selectedMode;
    const workMin = state.workDuration || 25;
    DOM.timerDisplay.textContent = `${String(workMin).padStart(2, '0')}:00`;
    DOM.timerPhase.textContent = 'READY';
    DOM.timerRingProgress.style.strokeDashoffset = RING_CIRCUMFERENCE;
  }

  // Session counter
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
    // Use the paused phase to determine total
    if (state.pausedPhase === 'work') return (state.workDuration || 25) * 60 * 1000;
    if (state.pausedPhase === 'break') return (state.breakDuration || 5) * 60 * 1000;
  }
  return (state.workDuration || 25) * 60 * 1000;
}

function renderControls(state) {
  const { sessionActive, sessionPhase } = state;

  if (!sessionActive || sessionPhase === 'idle') {
    // Not started — show Start only
    show(DOM.btnStart);
    hide(DOM.btnPause);
    hide(DOM.btnResume);
    hide(DOM.btnStop);
  } else if (sessionPhase === 'paused') {
    // Paused — show Resume + Stop
    hide(DOM.btnStart);
    hide(DOM.btnPause);
    show(DOM.btnResume);
    show(DOM.btnStop);
  } else {
    // Running (work or break) — show Pause + Stop
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

  // Focus time
  const totalMs = stats.totalFocusMs || 0;
  const hours = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  DOM.statFocus.textContent = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  // Sessions
  DOM.statSessions.textContent = stats.sessionsCompleted || 0;

  // Distractions blocked
  DOM.statBlocked.textContent = stats.distractionsBlocked || 0;
}

function renderSettings(state) {
  DOM.settingWork.textContent = state.workDuration || 25;
  DOM.settingBreak.textContent = state.breakDuration || 5;
  DOM.settingLongBreak.textContent = state.longBreakDuration || 15;
  DOM.settingSessions.textContent = state.sessionsBeforeLongBreak || 4;

  currentBlacklist = state.blacklist || [];
  renderBlacklist();
}

function renderBlacklist() {
  DOM.whitelistList.innerHTML = '';
  currentBlacklist.forEach((domain, index) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = domain;
    const btn = document.createElement('button');
    btn.className = 'blacklist-remove';
    btn.textContent = '×';
    btn.onclick = () => {
      currentBlacklist.splice(index, 1);
      renderBlacklist();
    };
    li.appendChild(span);
    li.appendChild(btn);
    DOM.whitelistList.appendChild(li);
  });
}

// Timer Tick logic

function startTimerTick() {
  clearInterval(timerInterval);
  timerInterval = setInterval(async () => {
    if (!currentState) return;

    const { sessionActive, sessionPhase, endTime } = currentState;

    if (sessionActive && (sessionPhase === 'work' || sessionPhase === 'break') && endTime) {
      const diff = Math.max(0, endTime - Date.now());
      DOM.timerDisplay.textContent = formatTime(diff);
      updateRing(currentState, diff);

      // If timer hit zero, re-fetch state (phase transition happened in background)
      if (diff <= 0) {
        const state = await sendMessage({ action: 'getState' });
        if (state) {
          currentState = state;
          renderFull(state);
        }
      }
    }
  }, 250); // 250ms for smooth display
}

// UI Event Handlers

// Start
DOM.btnStart.addEventListener('click', async () => {
  const state = await sendMessage({ action: 'startSession', mode: selectedMode });
  if (state && !state.error) {
    currentState = state;
    renderFull(state);
  }
});

// Pause
DOM.btnPause.addEventListener('click', async () => {
  const state = await sendMessage({ action: 'pauseSession' });
  if (state && !state.error) {
    currentState = state;
    renderFull(state);
  }
});

// Resume
DOM.btnResume.addEventListener('click', async () => {
  const state = await sendMessage({ action: 'resumeSession' });
  if (state && !state.error) {
    currentState = state;
    renderFull(state);
  }
});

// Stop
DOM.btnStop.addEventListener('click', async () => {
  const state = await sendMessage({ action: 'stopSession' });
  if (state && !state.error) {
    currentState = state;
    renderFull(state);
  }
});

// Settings toggle
DOM.settingsToggle.addEventListener('click', () => {
  const panel = DOM.settingsPanel;
  const isHidden = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  DOM.settingsToggle.classList.toggle('active', isHidden);
});

// Settings adjustment buttons
document.querySelectorAll('.setting-adj').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (currentState && currentState.sessionActive) return; // No changes during session

    const targetId = btn.dataset.target;
    const delta = parseInt(btn.dataset.delta, 10);
    const el = document.getElementById(targetId);
    let val = parseInt(el.textContent, 10) + delta;

    // Clamp values
    if (targetId === 'setting-work') val = Math.max(1, Math.min(120, val));
    if (targetId === 'setting-break') val = Math.max(1, Math.min(30, val));
    if (targetId === 'setting-long-break') val = Math.max(5, Math.min(60, val));
    if (targetId === 'setting-sessions') val = Math.max(1, Math.min(10, val));

    el.textContent = val;
  });
});

// Blacklist add
DOM.whitelistAddBtn.addEventListener('click', () => {
  const domain = DOM.whitelistInputNew.value.trim();
  if (domain && !currentBlacklist.includes(domain)) {
    currentBlacklist.push(domain);
    renderBlacklist();
  }
  DOM.whitelistInputNew.value = '';
});
DOM.whitelistInputNew.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') DOM.whitelistAddBtn.click();
});

// Save settings
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
    // Brief visual confirmation
    DOM.saveSettings.textContent = 'Saved ✓';
    setTimeout(() => { DOM.saveSettings.textContent = 'Save Settings'; }, 1200);
  }
});

// Helper Functions

function formatTime(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// Auto-close functionality for notifications

function handleNotify() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('notify') === 'true') {
    setTimeout(() => {
      window.close();
    }, 5000); // go back/close after 5 seconds
  }
}

// Boot script

handleNotify();
init();