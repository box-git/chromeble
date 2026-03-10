/**
 * popup.js – Orchestrates the full export flow.
 *
 * Flow:
 *  1. Validate active tab is web.whatsapp.com
 *  2. Ask background.js to inject injected.js into MAIN world
 *  3. Wait briefly for the listener to register
 *  4. Tell content.js to trigger extraction
 *  5. Receive contacts, render preview, enable CSV download
 */

(function () {
  'use strict';

  var extractedContacts = null;
  var extractedGroupName = null;

  var btnExport   = document.getElementById('btn-export');
  var btnDownload = document.getElementById('btn-download');
  var statusIdle    = document.getElementById('status-idle');
  var statusLoading = document.getElementById('status-loading');
  var statusSuccess = document.getElementById('status-success');
  var statusError   = document.getElementById('status-error');
  var groupNameEl   = document.getElementById('group-name');
  var contactCountEl = document.getElementById('contact-count');
  var errorMessageEl = document.getElementById('error-message');
  var preview     = document.getElementById('preview');
  var previewList = document.getElementById('preview-list');
  var previewCount = document.getElementById('preview-count');

  // ── UI helpers ─────────────────────────────────────────────────────────

  function showStatus(name) {
    statusIdle.classList.add('hidden');
    statusLoading.classList.add('hidden');
    statusSuccess.classList.add('hidden');
    statusError.classList.add('hidden');
    if (name === 'idle')    statusIdle.classList.remove('hidden');
    if (name === 'loading') statusLoading.classList.remove('hidden');
    if (name === 'success') statusSuccess.classList.remove('hidden');
    if (name === 'error')   statusError.classList.remove('hidden');
  }

  function showError(message) {
    errorMessageEl.textContent = message;
    showStatus('error');
    btnExport.classList.remove('hidden');
    btnDownload.classList.add('hidden');
    preview.classList.add('hidden');
    btnExport.disabled = false;
  }

  function showSuccess(groupName, contacts) {
    groupNameEl.textContent = groupName;
    contactCountEl.textContent = contacts.length + ' אנשי קשר';
    showStatus('success');
    btnExport.classList.add('hidden');
    btnDownload.classList.remove('hidden');
    renderPreview(contacts);
  }

  function renderPreview(contacts) {
    var max = 5;
    previewList.innerHTML = '';

    contacts.slice(0, max).forEach(function (c) {
      var item = document.createElement('div');
      item.className = 'preview-item';
      item.innerHTML =
        '<span class="preview-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="preview-phone">' + escapeHtml(c.phone) + '</span>' +
        (c.isAdmin ? '<span class="preview-badge">מנהל</span>' : '');
      previewList.appendChild(item);
    });

    if (contacts.length > max) {
      var more = document.createElement('div');
      more.className = 'preview-more';
      more.textContent = '+ עוד ' + (contacts.length - max) + ' אנשי קשר...';
      previewList.appendChild(more);
    }

    previewCount.textContent = contacts.length + ' סה"כ';
    preview.classList.remove('hidden');
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── CSV helpers ────────────────────────────────────────────────────────

  function csvEscape(value) {
    var str = String(value == null ? '' : value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function generateCsv(contacts) {
    var BOM = '\uFEFF'; // UTF-8 BOM: ensures Excel opens Hebrew names correctly
    var header = ['Name', 'Phone', 'IsAdmin'];
    var rows = contacts.map(function (c) {
      return [csvEscape(c.name), csvEscape(c.phone), c.isAdmin ? 'true' : 'false'];
    });
    var lines = [header.join(',')].concat(rows.map(function (r) { return r.join(','); }));
    return BOM + lines.join('\r\n');
  }

  function datestamp() {
    var d = new Date();
    var pad = function (n) { return n.toString().padStart(2, '0'); };
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  function sanitizeFilename(name) {
    return (name || 'whatsapp-group')
      .replace(/[^\w\u0590-\u05FF\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .substring(0, 50);
  }

  function downloadCsv(csvContent, groupName) {
    var filename = sanitizeFilename(groupName) + '_contacts_' + datestamp() + '.csv';
    var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ── Export flow ────────────────────────────────────────────────────────

  btnExport.addEventListener('click', function () {
    btnExport.disabled = true;
    extractedContacts = null;
    showStatus('loading');
    preview.classList.add('hidden');

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];

      if (!tab) {
        showError('לא נמצא טאב פעיל.');
        return;
      }

      if (!tab.url || !tab.url.includes('web.whatsapp.com')) {
        showError('התוסף עובד רק על web.whatsapp.com.\nפתח את WhatsApp Web ונסה שוב.');
        return;
      }

      // Step 1: Inject injected.js into MAIN world via background service worker
      chrome.runtime.sendMessage({ type: 'INJECT_MAIN_WORLD', tabId: tab.id }, function (injectResp) {
        if (chrome.runtime.lastError) {
          showError('שגיאת הזרקה: ' + chrome.runtime.lastError.message);
          return;
        }
        if (!injectResp || !injectResp.ok) {
          showError('לא הצלחנו להזריק לדף: ' + (injectResp && injectResp.error ? injectResp.error : 'שגיאה לא ידועה'));
          return;
        }

        // Step 2: Small delay to let injected.js register its message listener
        setTimeout(function () {
          // Step 3: Trigger extraction via content.js bridge
          chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CONTACTS' }, function (response) {
            if (chrome.runtime.lastError) {
              showError('שגיאת תקשורת: ' + chrome.runtime.lastError.message + '\nרענן את הדף ונסה שוב.');
              return;
            }

            if (!response) {
              showError('לא התקבלה תשובה מהדף. רענן ונסה שוב.');
              return;
            }

            if (response.error) {
              showError(response.message || 'שגיאה לא ידועה.');
              return;
            }

            if (!response.contacts || response.contacts.length === 0) {
              showError('לא נמצאו אנשי קשר בקבוצה.');
              return;
            }

            extractedContacts = response.contacts;
            extractedGroupName = response.groupName || 'קבוצה';
            showSuccess(extractedGroupName, extractedContacts);
          });
        }, 200);
      });
    });
  });

  // ── Download ───────────────────────────────────────────────────────────

  btnDownload.addEventListener('click', function () {
    if (!extractedContacts || extractedContacts.length === 0) {
      showError('אין נתונים להורדה. לחץ על "ייצא CSV" תחילה.');
      return;
    }
    var csv = generateCsv(extractedContacts);
    downloadCsv(csv, extractedGroupName);
  });

  // Initial state
  showStatus('idle');
})();
