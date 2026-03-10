/**
 * content.js – Runs in the isolated world of the WhatsApp Web page.
 * Injects injected.js into the page context and bridges messages
 * between the popup and the page-context script.
 */

(function () {
  'use strict';

  let injected = false;

  function injectScript() {
    if (injected) return;
    injected = true;

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = function () {
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // Inject on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectScript);
  } else {
    injectScript();
  }

  // Listen for messages from the popup
  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.type !== 'EXTRACT_CONTACTS') return false;

    // Check if WhatsApp Web UI is loaded
    const waLoaded =
      document.querySelector('[data-testid="chat-list"]') ||
      document.querySelector('#app .two') ||
      document.querySelector('[data-testid="default-user"]') ||
      document.getElementById('app');

    if (!waLoaded) {
      sendResponse({ error: 'wa_not_loaded', message: 'WhatsApp Web טרם נטען. המתן לטעינה המלאה ונסה שוב.' });
      return false;
    }

    // Make sure script is injected
    injectScript();

    // One-time listener for the result from injected.js
    function onPageMessage(event) {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'WA_CONTACTS_RESULT') return;

      window.removeEventListener('message', onPageMessage);
      sendResponse(event.data.payload);
    }

    window.addEventListener('message', onPageMessage);

    // Trigger extraction in page context
    window.postMessage({ type: 'WA_EXTRACT_CONTACTS' }, '*');

    // Timeout after 10 seconds
    setTimeout(function () {
      window.removeEventListener('message', onPageMessage);
      sendResponse({ error: 'timeout', message: 'הבקשה פג זמן. נסה שוב.' });
    }, 10000);

    return true; // Keep message channel open for async response
  });
})();
