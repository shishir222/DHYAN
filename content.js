let floatingTimerEl = null;
let floatingInterval = null;
let currentEndTime = null;
let currentPhase = null;
let showFloatingTimer = true;

let isDragging = false;
let startX = 0;
let startY = 0;
let initialLeft = 0;
let initialTop = 0;

// Enable drag-and-drop on the floating timer element
function makeDraggable(el) {
  if (!el) return;

  try {
    const savedLeft = localStorage.getItem('dhyan_timer_left');
    const savedTop = localStorage.getItem('dhyan_timer_top');
    if (savedLeft !== null && savedTop !== null) {
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      el.style.setProperty('left', `${savedLeft}px`, 'important');
      el.style.setProperty('top', `${savedTop}px`, 'important');
    }
  } catch { /* ignore storage errors */ }

  const onPointerDown = (e) => {
    if (e.type === 'mousedown' && e.button !== 0) return;

    isDragging = true;
    el.classList.add('dhyan-dragging');

    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);

    const rect = el.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    startX = clientX;
    startY = clientY;

    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
    el.style.setProperty('left', `${initialLeft}px`, 'important');
    el.style.setProperty('top', `${initialTop}px`, 'important');

    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('mouseup', onPointerUp);
    document.addEventListener('touchmove', onPointerMove, { passive: false });
    document.addEventListener('touchend', onPointerUp);
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    if (e.cancelable) e.preventDefault();

    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);

    const deltaX = clientX - startX;
    const deltaY = clientY - startY;

    let newLeft = initialLeft + deltaX;
    let newTop = initialTop + deltaY;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const rect = el.getBoundingClientRect();

    newLeft = Math.max(0, Math.min(newLeft, viewportWidth - rect.width));
    newTop = Math.max(0, Math.min(newTop, viewportHeight - rect.height));

    el.style.setProperty('left', `${newLeft}px`, 'important');
    el.style.setProperty('top', `${newTop}px`, 'important');
  };

  const onPointerUp = () => {
    if (!isDragging) return;
    isDragging = false;
    el.classList.remove('dhyan-dragging');

    const rect = el.getBoundingClientRect();
    try {
      localStorage.setItem('dhyan_timer_left', `${rect.left}`);
      localStorage.setItem('dhyan_timer_top', `${rect.top}`);
    } catch { /* ignore storage errors */ }

    document.removeEventListener('mousemove', onPointerMove);
    document.removeEventListener('mouseup', onPointerUp);
    document.removeEventListener('touchmove', onPointerMove);
    document.removeEventListener('touchend', onPointerUp);
  };

  el.addEventListener('mousedown', onPointerDown);
  el.addEventListener('touchstart', onPointerDown, { passive: true });
}

function createFloatingTimer() {
  if (floatingTimerEl) return;

  floatingTimerEl = document.createElement('div');
  floatingTimerEl.id = 'dhyan-floating-timer';
  floatingTimerEl.innerHTML = `
    <div id="dhyan-floating-label">🔒 Focus</div>
    <div id="dhyan-floating-time">--:--</div>
  `;

  makeDraggable(floatingTimerEl);
  floatingTimerEl.style.opacity = '0';

  if (document.body) {
    document.body.appendChild(floatingTimerEl);
  } else if (document.documentElement) {
    document.documentElement.appendChild(floatingTimerEl);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (document.body) {
        document.body.appendChild(floatingTimerEl);
      }
    });
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (floatingTimerEl) {
        floatingTimerEl.style.opacity = '1';
      }
    });
  });
}

function removeFloatingTimer() {
  if (floatingTimerEl) {
    floatingTimerEl.style.opacity = '0';
    const el = floatingTimerEl;
    setTimeout(() => {
      el.remove();
    }, 300);
    floatingTimerEl = null;
  }
  if (floatingInterval) {
    clearInterval(floatingInterval);
    floatingInterval = null;
  }
  currentEndTime = null;
  currentPhase = null;
}

function updateFloatingTime() {
  if (!currentEndTime || !floatingTimerEl) return;

  const timeEl = floatingTimerEl.querySelector('#dhyan-floating-time');
  const labelEl = floatingTimerEl.querySelector('#dhyan-floating-label');
  if (!timeEl) return;

  const diff = Math.max(0, currentEndTime - Date.now());
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  timeEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  if (labelEl) {
    if (currentPhase === 'break') {
      labelEl.textContent = '☕ Break';
    } else {
      labelEl.textContent = '🔒 Focus';
    }
  }
}

function applyTimerState(state) {
  if (!state) return;

  if (state.showFloatingTimer !== undefined) {
    showFloatingTimer = state.showFloatingTimer;
  }

  const isActive = state.sessionActive &&
    (state.sessionPhase === 'work' || state.sessionPhase === 'break');

  const isPaused = state.sessionActive && state.sessionPhase === 'paused';

  if (isActive && state.endTime) {
    currentPhase = state.sessionPhase;
    currentEndTime = state.endTime;

    if (showFloatingTimer) {
      createFloatingTimer();
      updateFloatingTime();
      if (floatingInterval) clearInterval(floatingInterval);
      floatingInterval = setInterval(updateFloatingTime, 1000);
    } else {
      removeFloatingTimer();
    }
  } else if (isPaused && state.pausedTimeRemaining != null) {
    if (showFloatingTimer) {
      createFloatingTimer();
      const timeEl = floatingTimerEl ? floatingTimerEl.querySelector('#dhyan-floating-time') : null;
      const labelEl = floatingTimerEl ? floatingTimerEl.querySelector('#dhyan-floating-label') : null;
      if (timeEl) {
        const diff = state.pausedTimeRemaining;
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        timeEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      }
      if (labelEl) {
        labelEl.textContent = '⏸ Paused';
      }
      if (floatingInterval) {
        clearInterval(floatingInterval);
        floatingInterval = null;
      }
    } else {
      removeFloatingTimer();
    }
  } else {
    removeFloatingTimer();
  }
}

chrome.runtime.sendMessage({ action: 'getTimerState' }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response) {
    applyTimerState(response);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updateBlockState' && request.state) {
    applyTimerState({
      sessionActive: request.state.sessionActive,
      sessionPhase: request.state.sessionPhase,
      endTime: request.state.endTime,
      pausedTimeRemaining: request.state.pausedTimeRemaining,
      showFloatingTimer: request.state.showFloatingTimer,
    });
  }
});
