/* MetaWatch Browser Extension — Background Service Worker */

// On install: open the popup (via action) so user can configure settings
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    // Open extension options/popup on first install
    chrome.action.openPopup().catch(() => {
      // openPopup may fail if not triggered by user gesture — that's fine
    });
  }
});

// Listen for messages from popup (future expansion)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse({ pong: true });
  }
});
