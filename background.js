const DEFAULT_STATE = {
  sessionActive: false,
  sessionPhase: 'idle',
  pausedPhase: null,
  pausedByBlock: false,

  workDuration: 25,
  breakDuration: 5,
  longBreakDuration: 15,
  sessionsBeforeLongBreak: 4,
  currentSessionCount: 0,
  endTime: null,
  pausedTimeRemaining: null,

  focusTabId: null,
  focusWindowId: null,
  focusTabUrl: null,
  lastAllowedUrl: null,

  blacklist: [],
  showFloatingTimer: true,

  stats: {
    totalFocusMs: 0,
    totalBreakMs: 0,
    sessionsCompleted: 0,
    distractionsBlocked: 0,
    lastSessionDate: null,
  },
};

// Manage extension state and local storage caching
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
        console.error('State mutation failed:', err);
      });
    return mutexChain;
  }

  return { load, save, getCache, mutate };
})();

// Pomodoro timer logic
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
    scheduleBadgeUpdate();
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
      playOffscreenAudio();
      broadcastState();
    }
  }

  return { startPhase, onAlarmFire };
})();

// Offscreen document helper for audio playback
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
      justification: 'Play chime sound when break starts or ends'
    });
  }

  chrome.runtime.sendMessage({ action: 'playChime' });
}

// Check if URL matches any blacklisted domain
function isUrlBlacklisted(url, blacklist) {
  if (!url || !blacklist || blacklist.length === 0) return false;

  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  return blacklist.some((domain) => {
    const d = domain.toLowerCase();
    return hostname === d || hostname.endsWith('.' + d);
  });
}

const BLOCKED_PAGE_URL = chrome.runtime.getURL('blocked.html');

function isNewTabUrl(url) {
  if (!url) return false;
  const lUrl = url.toLowerCase();
  return (
    lUrl === 'chrome://newtab/' ||
    lUrl === 'chrome://newtab' ||
    lUrl === 'chrome://new-tab-page/' ||
    lUrl === 'chrome://new-tab-page' ||
    lUrl === 'about:blank' ||
    lUrl.startsWith('chrome://newtab') ||
    lUrl.startsWith('chrome://new-tab-page')
  );
}

// Prevent opening new tabs during focus session
chrome.tabs.onCreated.addListener(async (tab) => {
  await StateManager.load();
  const s = StateManager.getCache();

  if (s.sessionActive && s.sessionPhase === 'work') {
    const url = tab.pendingUrl || tab.url || '';
    if (url.startsWith(chrome.runtime.getURL(''))) return;

    try {
      await chrome.tabs.remove(tab.id);
      await StateManager.mutate((st) => {
        st.stats.distractionsBlocked += 1;
      });
    } catch (err) {
      console.warn('Failed to remove new tab:', err);
    }
  }
});

// Monitor tab updates and redirect blacklisted URLs
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (changeInfo.url.startsWith(chrome.runtime.getURL(''))) return;

  await StateManager.load();
  const s = StateManager.getCache();

  if (!s.sessionActive) return;

  const isNewTab = isNewTabUrl(changeInfo.url);
  const isBlacklisted = isUrlBlacklisted(changeInfo.url, s.blacklist || []);

  if (isNewTab || isBlacklisted) {
    await pauseForBlockedPage();
    await StateManager.load();
    if (!StateManager.getCache().pausedByBlock) return;

    await StateManager.mutate((st) => {
      st.stats.distractionsBlocked += 1;
    });

    chrome.tabs.update(tabId, { url: BLOCKED_PAGE_URL });
  } else {
    await StateManager.mutate((st) => {
      st.lastAllowedUrl = changeInfo.url;
    });
    if (s.sessionPhase === 'paused' && s.pausedByBlock) await resumeSession();
  }
});

// Sync state across content scripts
async function broadcastState() {
  const state = StateManager.getCache();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      chrome.tabs.sendMessage(tab.id, { action: 'updateBlockState', state });
    } catch {
      // Tab may not have content script
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
    s.lastAllowedUrl = url;
    s.currentSessionCount = 0;
    s.pausedPhase = null;
    s.pausedTimeRemaining = null;
    s.pausedByBlock = false;
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
    st.pausedByBlock = false;
    st.currentSessionCount = 0;
  });

  chrome.alarms.clear('pomodoro');
  chrome.alarms.clear('badge');
  chrome.action.setBadgeText({ text: '' });
  broadcastState();
}

async function endSession(reason) {
  console.log('Session ended:', reason);
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
    st.pausedByBlock = false;
  });

  chrome.alarms.clear('pomodoro');
  updateBadge();
  broadcastState();
}

async function pauseForBlockedPage() {
  await StateManager.load();
  const s = StateManager.getCache();
  if (!s.sessionActive) return;

  if (s.sessionPhase === 'work') await pauseSession();

  await StateManager.mutate((st) => {
    if (st.sessionActive && st.sessionPhase === 'paused') {
      st.pausedByBlock = true;
    }
  });
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
    st.pausedByBlock = false;
  });

  const updated = StateManager.getCache();
  chrome.alarms.create('pomodoro', { when: updated.endTime });
  updateBadge();
  scheduleBadgeUpdate();
  broadcastState();
}

function updateBadge() {
  chrome.action.setBadgeText({ text: '' });
}

function scheduleBadgeUpdate() {
  chrome.alarms.clear('badge');
}

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
    console.warn('Notification failed:', err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  const merged = { ...DEFAULT_STATE, ...existing };
  if (existing.stats) {
    merged.stats = { ...DEFAULT_STATE.stats, ...existing.stats };
  }
  await chrome.storage.local.set(merged);
  await StateManager.load();
  chrome.action.setBadgeText({ text: '' });
});

chrome.runtime.onStartup.addListener(async () => {
  await StateManager.load();
  const s = StateManager.getCache();
  chrome.action.setBadgeText({ text: '' });

  if (s.sessionActive) {
    if (s.endTime && Date.now() >= s.endTime) {
      await endSession('Chrome restarted after timer expired');
    } else if (s.endTime) {
      chrome.alarms.create('pomodoro', { when: s.endTime });
      broadcastState();
    } else if (s.sessionPhase === 'paused') {
      broadcastState();
    } else {
      await endSession('Corrupted state on startup');
    }
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'pomodoro') {
    await PomodoroTimer.onAlarmFire();
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then((response) => sendResponse(response))
    .catch((err) => {
      console.error('Message handler error:', err);
      sendResponse({ error: err.message });
    });
  return true;
});

async function handleMessage(req, sender) {
  await StateManager.load();

  switch (req.action) {
    case 'backToWork': {
      const tabId = req.tabId ?? sender?.tab?.id;
      const s = StateManager.getCache();
      if (tabId == null || !s.sessionActive) return { error: 'No active session' };

      const previousAllowedUrl = s.lastAllowedUrl || s.focusTabUrl;
      const targetUrl = previousAllowedUrl && !isUrlBlacklisted(previousAllowedUrl, s.blacklist || []) && !isNewTabUrl(previousAllowedUrl)
        ? previousAllowedUrl
        : 'https://www.google.com/';
      await chrome.tabs.update(tabId, { url: targetUrl });
      if (s.sessionPhase === 'paused' && s.pausedByBlock) await resumeSession();
      return StateManager.getCache();
    }

    case 'ensureBlockedPause': {
      await pauseForBlockedPage();
      const state = StateManager.getCache();
      return {
        sessionActive: state.sessionActive,
        sessionPhase: state.sessionPhase,
        pausedTimeRemaining: state.pausedTimeRemaining,
      };
    }

    case 'openPopup': {
      await chrome.action.openPopup();
      return { ok: true };
    }

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

    case 'getTimerState': {
      const s = StateManager.getCache();
      return {
        sessionActive: s.sessionActive,
        sessionPhase: s.sessionPhase,
        endTime: s.endTime,
        pausedTimeRemaining: s.pausedTimeRemaining,
        showFloatingTimer: s.showFloatingTimer,
      };
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

    case 'updateShowFloatingTimer': {
      await StateManager.mutate((s) => {
        s.showFloatingTimer = !!req.value;
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
      const isBlacklisted = state.blacklist && state.blacklist.some(domain => {
        const d = domain.toLowerCase();
        const h = hostname.toLowerCase();
        return h === d || h.endsWith('.' + d);
      });
      const shouldBlock = isBlacklisted && state.sessionActive && state.sessionPhase === 'work';
      return { isBlocked: shouldBlock, endTime: state.endTime };
    }

    default:
      return { error: `Unknown action: ${req.action}` };
  }
}