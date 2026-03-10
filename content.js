/**
 * content.js – Runs in the ISOLATED world of web.whatsapp.com.
 *
 * Pure message bridge between:
 *   - popup.js (via chrome.runtime messages)
 *   - injected.js (via window.postMessage in MAIN world)
 *
 * injected.js is injected into the MAIN world by background.js using
 * chrome.scripting.executeScript, NOT by this script. This is the correct
 * MV3 approach that avoids CSP issues and isolated-world restrictions.
 */

(function () {
  'use strict';

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.type !== 'EXTRACT_CONTACTS') return false;

    // Forward the trigger to injected.js (MAIN world) via postMessage
    window.postMessage({ type: 'WA_EXPORTER_EXTRACT' }, '*');

    // Wait for the response from injected.js
    function onResult(event) {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'WA_EXPORTER_RESULT') return;
      window.removeEventListener('message', onResult);
      sendResponse(event.data.payload);
    }

    window.addEventListener('message', onResult);

    // Timeout safety: 15 seconds
    setTimeout(function () {
      window.removeEventListener('message', onResult);
      sendResponse({ error: 'timeout', message: 'Request timed out. Please try again.' });
    }, 15000);

    return true; // Keep message channel open for async sendResponse
  });
})();
