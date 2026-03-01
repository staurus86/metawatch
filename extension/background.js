/* MetaWatch Browser Extension — Background Service Worker */

// On install: open settings page so user can configure API URL/key
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => {});
  }
});

// Listen for messages from popup (future expansion)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse({ pong: true });
  }
});
