/**
 * popup.js – Popup logic for the WhatsApp Contacts Exporter extension.
 * Handles UI state, communicates with the content script, and generates CSV.
 */

(function () {
  'use strict';

  let extractedContacts = null;
  let extractedGroupName = null;

  // UI elements
  const btnExport = document.getElementById('btn-export');
  const btnDownload = document.getElementById('btn-download');
  const statusIdle = document.getElementById('status-idle');
  const statusLoading = document.getElementById('status-loading');
  const statusSuccess = document.getElementById('status-success');
  const statusError = document.getElementById('status-error');
  const groupNameEl = document.getElementById('group-name');
  const contactCountEl = document.getElementById('contact-count');
  const errorMessageEl = document.getElementById('error-message');
  const preview = document.getElementById('preview');
  const previewList = document.getElementById('preview-list');
  const previewCount = document.getElementById('preview-count');

  function showStatus(name) {
    statusIdle.classList.add('hidden');
    statusLoading.classList.add('hidden');
    statusSuccess.classList.add('hidden');
    statusError.classList.add('hidden');

    if (name === 'idle') statusIdle.classList.remove('hidden');
    else if (name === 'loading') statusLoading.classList.remove('hidden');
    else if (name === 'success') statusSuccess.classList.remove('hidden');
    else if (name === 'error') statusError.classList.remove('hidden');
  }

  function showError(message) {
    errorMessageEl.textContent = message;
    showStatus('error');
    btnExport.classList.remove('hidden');
    btnDownload.classList.add('hidden');
    preview.classList.add('hidden');
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
    const max = 5;
    previewList.innerHTML = '';

    contacts.slice(0, max).forEach(function (c) {
      const item = document.createElement('div');
      item.className = 'preview-item';
      item.innerHTML =
        '<span class="preview-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="preview-phone">' + escapeHtml(c.phone) + '</span>' +
        (c.isAdmin ? '<span class="preview-badge">מנהל</span>' : '');
      previewList.appendChild(item);
    });

    if (contacts.length > max) {
      const more = document.createElement('div');
      more.className = 'preview-more';
      more.textContent = '+ עוד ' + (contacts.length - max) + ' אנשי קשר...';
      previewList.appendChild(more);
    }

    previewCount.textContent = contacts.length + ' סה"כ';
    preview.classList.remove('hidden');
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function generateCsv(contacts) {
    const BOM = '\uFEFF'; // UTF-8 BOM for Hebrew support in Excel
    const header = ['Name', 'Phone', 'IsAdmin'];
    const rows = contacts.map(function (c) {
      return [
        csvEscape(c.name),
        csvEscape(c.phone),
        c.isAdmin ? 'true' : 'false',
      ];
    });

    const lines = [header.join(',')].concat(
      rows.map(function (r) { return r.join(','); })
    );

    return BOM + lines.join('\r\n');
  }

  function csvEscape(value) {
    const str = String(value);
    // Wrap in quotes if contains comma, quote, or newline
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function downloadCsv(csvContent, filename) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function sanitizeFilename(name) {
    return (name || 'whatsapp-contacts')
      .replace(/[^\w\u0590-\u05FF\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .substring(0, 50);
  }

  // Handle Export button click – fetch contacts from WhatsApp Web
  btnExport.addEventListener('click', function () {
    btnExport.disabled = true;
    showStatus('loading');
    preview.classList.add('hidden');
    extractedContacts = null;

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tab = tabs && tabs[0];

      if (!tab) {
        showError('לא נמצא טאב פעיל.');
        btnExport.disabled = false;
        return;
      }

      if (!tab.url || !tab.url.includes('web.whatsapp.com')) {
        showError('התוסף עובד רק על web.whatsapp.com. פתח את WhatsApp Web ונסה שוב.');
        btnExport.disabled = false;
        return;
      }

      chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CONTACTS' }, function (response) {
        btnExport.disabled = false;

        if (chrome.runtime.lastError) {
          showError('שגיאת תקשורת: ' + chrome.runtime.lastError.message + '. רענן את הדף ונסה שוב.');
          return;
        }

        if (!response) {
          showError('לא התקבלה תשובה מהדף. רענן את הדף ונסה שוב.');
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
    });
  });

  // Handle Download button click – generate and download CSV
  btnDownload.addEventListener('click', function () {
    if (!extractedContacts || extractedContacts.length === 0) {
      showError('אין נתונים להורדה. לחץ על "ייצא CSV" תחילה.');
      return;
    }

    const csv = generateCsv(extractedContacts);
    const filename = sanitizeFilename(extractedGroupName) + '_contacts.csv';
    downloadCsv(csv, filename);
  });

  // Initial state
  showStatus('idle');
})();
