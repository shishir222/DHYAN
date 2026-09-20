const remainingTime = document.getElementById('remaining-time');
const backToWorkButton = document.getElementById('back-to-work');

function formatTime(ms) {
  const totalSec = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function renderTimer(state) {
  if (!state || state.pausedTimeRemaining == null) return;
  remainingTime.textContent = formatTime(state.pausedTimeRemaining);
}

function refreshTimer() {
  chrome.runtime.sendMessage({ action: 'getTimerState' }, (state) => {
    if (chrome.runtime.lastError) return;
    renderTimer(state);
  });
}

chrome.runtime.sendMessage({ action: 'ensureBlockedPause' }, () => {
  if (chrome.runtime.lastError) return;
  refreshTimer();
});

setInterval(refreshTimer, 1000);

backToWorkButton.addEventListener('click', () => {
  backToWorkButton.disabled = true;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (chrome.runtime.lastError || !tab) return;
    chrome.runtime.sendMessage({ action: 'backToWork', tabId: tab.id });
  });
});