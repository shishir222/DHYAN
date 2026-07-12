let overlayElement = null;
let timerInterval = null;
let endTime = null;

function createOverlay() {
  if (overlayElement) return;

  overlayElement = document.createElement('div');
  overlayElement.id = 'dhyan-block-overlay';
  
  overlayElement.innerHTML = `
    <div id="dhyan-block-container">
      <h1>Get Back To Work!</h1>
      <p class="dhyan-subtitle">You added this site to your blacklist for a reason. Stop slacking off and get back to your focus session!</p>

      <div class="dhyan-timer-display">
        <span id="dhyan-block-timer">--:--</span>
        <span class="dhyan-timer-label">remaining in session</span>
      </div>

      <div class="dhyan-creative-message">
        <p>"The future depends on what you do today." — Mahatma Gandhi</p>
      </div>

      <p class="dhyan-footer-note">DHYAN — Stay in the zone.</p>
    </div>
  `;
  
  if (document.body) {
    document.body.appendChild(overlayElement);
    // Prevent scrolling
    document.body.style.overflow = 'hidden';
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.appendChild(overlayElement);
      document.body.style.overflow = 'hidden';
    });
  }
}

function removeOverlay() {
  if (overlayElement) {
    overlayElement.remove();
    overlayElement = null;
    document.body.style.overflow = '';
  }
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimer() {
  if (!endTime) return;
  const timerEl = document.getElementById('dhyan-block-timer');
  if (!timerEl) return;
  
  const diff = endTime - Date.now();
  if (diff <= 0) {
    timerEl.textContent = '00:00';
    return;
  }
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function applyBlockState(isBlocked, currentEndTime) {
  if (isBlocked) {
    createOverlay();
    endTime = currentEndTime;
    if (timerInterval) clearInterval(timerInterval);
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
  } else {
    removeOverlay();
  }
}

// Check state on load
chrome.runtime.sendMessage({ action: 'checkBlacklist', hostname: window.location.hostname }, (response) => {
  if (chrome.runtime.lastError) return; // Background script might not be ready
  if (response) {
    applyBlockState(response.isBlocked, response.endTime);
  }
});

// Listen for updates from background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updateBlockState') {
    // Determine if this site is still blocked under the new state
    const hostname = window.location.hostname;
    const isBlacklisted = request.state.blacklist && request.state.blacklist.some(domain => hostname.includes(domain));
    const shouldBlock = isBlacklisted && request.state.sessionActive && request.state.sessionPhase === 'work';
    
    applyBlockState(shouldBlock, request.state.endTime);
  }
});
