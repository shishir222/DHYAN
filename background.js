const DEFAULT_STATE = {
  // Session
  sessionActive: false,
  sessionPhase: 'idle',       // 'idle' | 'work' | 'break' | 'paused'
  pausedPhase: null,          // phase before pause ('work' | 'break')

  // Timer
  workDuration: 25,           // minutes
  breakDuration: 5,           // minutes
  longBreakDuration: 15,      // minutes
  sessionsBeforeLongBreak: 4,
  currentSessionCount: 0,
  endTime: null,
  pausedTimeRemaining: null,  // ms remaining when paused

  // Focus lock
  focusTabId: null,
  focusWindowId: null,
  focusTabUrl: null,

  // Deep Lock blacklist
  blacklist: [],              // array of domain strings

  // Statistics
  stats: {
    totalFocusMs: 0,
    totalBreakMs: 0,
    sessionsCompleted: 0,
    distractionsBlocked: 0,
    lastSessionDate: null,
  },
};

// State Manager handles storage and caching

const StateManager = (() => {
  let cache = { ...DEFAULT_STATE };
  let mutexChain = Promise.resolve();

  async function load() {
    const stored = await chrome.storage.local.get(null);
    cache = { ...DEFAULT_STATE, ...stored };
    if (stored.stats) {
      cache.stats = { ...DEFAULT_STATE.stats, ...stored.stats };
    }
    return cache;
  }

  async function save() {
    await chrome.storage.local.set(cache);
  }

  function getCache() {
    return cache;
  }

  function mutate(fn) {
    mutexChain = mutexChain
      .then(() => load())
      .then(() => fn(cache))
      .then((result) => save().then(() => result))
      .catch((err) => {
        console.error('[FocusLock] mutate error:', err);
      });
    return mutexChain;
  }

  return { load, save, getCache, mutate };
})();

// Pomodoro Timer manages work and break phases

const PomodoroTimer = (() => {

  async function startPhase(phase) {
    await StateManager.mutate((s) => {
      s.sessionPhase = phase;
      s.pausedPhase = null;
      s.pausedTimeRemaining = null;

      let durationMin;
      if (phase === 'work') {
        durationMin = s.workDuration;
      } else if (phase === 'break') {
        if (s.currentSessionCount > 0 && s.currentSessionCount % s.sessionsBeforeLongBreak === 0) {
          durationMin = s.longBreakDuration;
        } else {
          durationMin = s.breakDuration;
        }
      }

      s.endTime = Date.now() + durationMin * 60 * 1000;
    });

    const s = StateManager.getCache();
    chrome.alarms.clear('pomodoro');
    chrome.alarms.create('pomodoro', { when: s.endTime });

    updateBadge();
  }

  async function onAlarmFire() {
    await StateManager.load();
    const s = StateManager.getCache();

    if (!s.sessionActive || s.sessionPhase === 'paused') return;

    if (s.sessionPhase === 'work') {
      await StateManager.mutate((st) => {
        st.currentSessionCount += 1;
        st.stats.totalFocusMs += st.workDuration * 60 * 1000;
        st.stats.sessionsCompleted += 1;
        st.stats.lastSessionDate = new Date().toISOString().split('T')[0];
      });
      
      showNotification('Break Time!', 'Great work! Take a short break.');
      await startPhase('break');
      
      // Notify user via dashboard and sound
      chrome.windows.create({
        url: 'popup.html?notify=true',
        type: 'popup',
        width: 320,
        height: 480,
        focused: true
      });
      playOffscreenAudio();
      broadcastState();
      
    } else if (s.sessionPhase === 'break') {
      await StateManager.mutate((st) => {
        const breakDur = (st.currentSessionCount % st.sessionsBeforeLongBreak === 0)
          ? st.longBreakDuration : st.breakDuration;
        st.stats.totalBreakMs += breakDur * 60 * 1000;
      });
      showNotification('Focus Time!', 'Break is over. Let\'s get back to work!');
      await startPhase('work');
      broadcastState();
    }
  }

  return { startPhase, onAlarmFire };
})();

// Offscreen Audio plays sound reliably without a visible window

async function playOffscreenAudio() {
  const offscreenUrl = 'audio.html';
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(offscreenUrl)]
  });

  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play chime sound when break starts'
    });
  }
  
  chrome.runtime.sendMessage({ action: 'playChime' });
}

// Session Control handles start, stop, pause, and resume actions

async function broadcastState() {
  const state = StateManager.getCache();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      chrome.tabs.sendMessage(tab.id, { action: 'updateBlockState', state });
    } catch {
      // Ignored
    }
  }
}

async function startSession(tabId, windowId) {
  let url = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab.url;
  } catch { /* ignore */ }

  await StateManager.mutate((s) => {
    s.sessionActive = true;
    s.sessionPhase = 'idle';
    s.focusTabId = tabId;
    s.focusWindowId = windowId;
    s.focusTabUrl = url;
    s.currentSessionCount = 0;
    s.pausedPhase = null;
    s.pausedTimeRemaining = null;
  });

  await PomodoroTimer.startPhase('work');
  showNotification('Focus Session Started', 'Focus Session active.');
  broadcastState();
}

async function stopSession() {
  await StateManager.load();
  const s = StateManager.getCache();

  if (s.sessionPhase === 'work' && s.endTime) {
    const elapsed = (s.workDuration * 60 * 1000) - Math.max(0, s.endTime - Date.now());
    await StateManager.mutate((st) => {
      st.stats.totalFocusMs += Math.max(0, elapsed);
    });
  }

  await StateManager.mutate((st) => {
    st.sessionActive = false;
    st.sessionPhase = 'idle';
    st.focusTabId = null;
    st.focusWindowId = null;
    st.focusTabUrl = null;
    st.endTime = null;
    st.pausedPhase = null;
    st.pausedTimeRemaining = null;
    st.currentSessionCount = 0;
  });

  chrome.alarms.clear('pomodoro');
  chrome.alarms.clear('badge');
  chrome.action.setBadgeText({ text: '' });
  broadcastState();
}

async function endSession(reason) {
  console.log('[FocusLock] Session ended:', reason);
  await stopSession();
}

async function pauseSession() {
  await StateManager.load();
  const s = StateManager.getCache();
  if (!s.sessionActive || s.sessionPhase === 'paused') return;

  const remaining = Math.max(0, s.endTime - Date.now());
  await StateManager.mutate((st) => {
    st.pausedPhase = st.sessionPhase;
    st.sessionPhase = 'paused';
    st.pausedTimeRemaining = remaining;
    st.endTime = null;
  });

  chrome.alarms.clear('pomodoro');
  updateBadge();
  broadcastState();
}

async function resumeSession() {
  await StateManager.load();
  const s = StateManager.getCache();
  if (!s.sessionActive || s.sessionPhase !== 'paused') return;

  const phase = s.pausedPhase || 'work';
  const remaining = s.pausedTimeRemaining || s.workDuration * 60 * 1000;

  await StateManager.mutate((st) => {
    st.sessionPhase = phase;
    st.endTime = Date.now() + remaining;
    st.pausedPhase = null;
    st.pausedTimeRemaining = null;
  });

  const updated = StateManager.getCache();
  chrome.alarms.create('pomodoro', { when: updated.endTime });
  updateBadge();
  broadcastState();
}

// Badge visually indicates the session phase on the extension icon

function updateBadge() {
  const s = StateManager.getCache();

  if (!s.sessionActive) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  if (s.sessionPhase === 'paused') {
    chrome.action.setBadgeText({ text: '||' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    return;
  }

  if (s.sessionPhase === 'break') {
    chrome.action.setBadgeText({ text: 'BRK' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    return;
  }

  if (s.sessionPhase === 'work' && s.endTime) {
    const remaining = Math.max(0, s.endTime - Date.now());
    const mins = Math.ceil(remaining / 60000);
    chrome.action.setBadgeText({ text: String(mins) });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  }
}

function scheduleBadgeUpdate() {
  chrome.alarms.create('badge', { periodInMinutes: 1 });
}

// Notifications send desktop alerts to the user

function showNotification(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title,
      message,
      priority: 2,
    });
  } catch (err) {
    console.warn('[FocusLock] Notification failed:', err);
  }
}

// Event Listeners for initialization and crashes

// Installation & Startup

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  const merged = { ...DEFAULT_STATE, ...existing };
  if (existing.stats) {
    merged.stats = { ...DEFAULT_STATE.stats, ...existing.stats };
  }
  await chrome.storage.local.set(merged);
  await StateManager.load();
});

chrome.runtime.onStartup.addListener(async () => {
  await StateManager.load();
  const s = StateManager.getCache();

  if (s.sessionActive) {
    if (s.endTime && Date.now() >= s.endTime) {
      await endSession('Chrome restarted after timer expired');
    } else if (s.endTime) {
      chrome.alarms.create('pomodoro', { when: s.endTime });
      scheduleBadgeUpdate();
      updateBadge();
      broadcastState();
    } else {
      await endSession('Corrupted state on startup');
    }
  }
});

// Alarm Handler for timer events

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'pomodoro') {
    await PomodoroTimer.onAlarmFire();
  } else if (alarm.name === 'badge') {
    await StateManager.load();
    updateBadge();
  }
});

// Message Handler handles communication between popup and background

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request)
    .then((response) => sendResponse(response))
    .catch((err) => {
      console.error('[FocusLock] message handler error:', err);
      sendResponse({ error: err.message });
    });
  return true;
});

async function handleMessage(req) {
  await StateManager.load();

  switch (req.action) {
    case 'startSession': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return { error: 'No active tab found' };
      await startSession(tab.id, tab.windowId);
      scheduleBadgeUpdate();
      return StateManager.getCache();
    }

    case 'stopSession': {
      await stopSession();
      return StateManager.getCache();
    }

    case 'pauseSession': {
      await pauseSession();
      return StateManager.getCache();
    }

    case 'resumeSession': {
      await resumeSession();
      return StateManager.getCache();
    }

    case 'getState': {
      return StateManager.getCache();
    }

    case 'updateSettings': {
      await StateManager.mutate((s) => {
        if (req.workDuration != null) s.workDuration = req.workDuration;
        if (req.breakDuration != null) s.breakDuration = req.breakDuration;
        if (req.longBreakDuration != null) s.longBreakDuration = req.longBreakDuration;
        if (req.sessionsBeforeLongBreak != null) s.sessionsBeforeLongBreak = req.sessionsBeforeLongBreak;
        if (req.blacklist != null) s.blacklist = req.blacklist;
      });
      broadcastState();
      return StateManager.getCache();
    }

    case 'resetStats': {
      await StateManager.mutate((s) => {
        s.stats = { ...DEFAULT_STATE.stats };
      });
      return StateManager.getCache();
    }

    case 'checkBlacklist': {
      const state = StateManager.getCache();
      const hostname = req.hostname || '';
      const isBlacklisted = state.blacklist && state.blacklist.some(domain => hostname.includes(domain));
      const shouldBlock = isBlacklisted && state.sessionActive && state.sessionPhase === 'work';
      return { isBlocked: shouldBlock, endTime: state.endTime };
    }

    default:
      return { error: `Unknown action: ${req.action}` };
  }
}