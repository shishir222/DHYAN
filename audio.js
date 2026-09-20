chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'playChime') {
    playChime();
    sendResponse({ ok: true });
  }
});

function playChime() {
  try {
    const bell = new Audio(chrome.runtime.getURL('bell.mp3'));
    bell.play();
  } catch (e) {
    console.error('Audio play failed', e);
  }
}
