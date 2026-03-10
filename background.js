/**
 * background.js – Service worker for WhatsApp Contacts Exporter.
 *
 * Responsible for injecting injected.js into the MAIN world of the WhatsApp Web
 * tab using the chrome.scripting API (Manifest v3). This bypasses the isolated
 * world restriction of content scripts and allows injected.js to access
 * window.require and WhatsApp's internal module registry.
 */

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg.type !== 'INJECT_MAIN_WORLD') return false;

  const tabId = msg.tabId;
  if (!tabId) {
    sendResponse({ ok: false, error: 'No tabId provided' });
    return false;
  }

  chrome.scripting
    .executeScript({
      target: { tabId: tabId },
      files: ['injected.js'],
      world: 'MAIN',
    })
    .then(function () {
      sendResponse({ ok: true });
    })
    .catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });

  return true; // Keep channel open for async response
});
