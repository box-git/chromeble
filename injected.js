/**
 * injected.js – Runs in the WhatsApp Web MAIN world (page context).
 *
 * Injected via chrome.scripting.executeScript({ world: 'MAIN' }) from background.js.
 * This gives access to window.require and WhatsApp Web's internal module registry.
 *
 * Communication flow:
 *   content.js → window.postMessage(WA_EXPORTER_EXTRACT) → [this file]
 *   [this file] → window.postMessage(WA_EXPORTER_RESULT) → content.js
 */

(function () {
  'use strict';

  // Guard against double-injection
  if (window.__waExporterInjected) return;
  window.__waExporterInjected = true;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function waitForRequire(maxMs) {
    maxMs = maxMs || 15000;
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      function check() {
        if (typeof window.require === 'function') return resolve();
        if (Date.now() - start > maxMs) return reject(new Error('WhatsApp not ready yet. Please wait for it to fully load and try again.'));
        setTimeout(check, 300);
      }
      check();
    });
  }

  function tryRequire(moduleName) {
    try { return window.require(moduleName); } catch (_) { return null; }
  }

  // Build a minimal Store by trying known WhatsApp Web module names.
  // Module names follow WAWeb* convention and are tried in priority order.
  function buildStore() {
    var store = {
      Chat: null,
      Contact: null,
      GroupMetadata: null,
      LidUtils: null,
    };

    // Chat collection
    var chatMod = (
      tryRequire('WAWebChatCollection') ||
      tryRequire('WAWebChatsCollection') ||
      tryRequire('WAWebChatStore')
    );
    if (chatMod) {
      store.Chat = chatMod.ChatCollection || chatMod.default || chatMod;
    }

    // Contact collection
    var contactMod = (
      tryRequire('WAWebContactCollection') ||
      tryRequire('WAWebContactStore')
    );
    if (contactMod) {
      store.Contact = contactMod.ContactCollection || contactMod.default || contactMod;
    }

    // Group metadata collection
    var groupMod = (
      tryRequire('WAWebGroupMetadataCollection') ||
      tryRequire('WAWebGroupMetadataStore')
    );
    if (groupMod) {
      store.GroupMetadata = groupMod.GroupMetadataCollection || groupMod.default || groupMod;
    }

    // LID utils – needed to resolve privacy-linked IDs to phone numbers
    var lidMod = tryRequire('WAWebLidUtils');
    if (lidMod) store.LidUtils = lidMod;

    // Fallback: scan all registered modules when named lookup fails
    if (!store.Chat || !store.Contact || !store.GroupMetadata) {
      scanModules(store);
    }

    return store;
  }

  // Secondary discovery: enumerate window.require.m module registry
  function scanModules(store) {
    var req = window.require;
    if (!req || !req.m) return;

    for (var id in req.m) {
      if (store.Chat && store.Contact && store.GroupMetadata) break;
      var mod;
      try { mod = req(id); } catch (_) { continue; }
      if (!mod || typeof mod !== 'object') continue;

      var m = (mod.default && typeof mod.default === 'object') ? mod.default : mod;

      if (!store.Chat && m.Chat && typeof m.Chat.getActive === 'function') {
        store.Chat = m.Chat;
      }
      if (!store.Chat && m.Chat && typeof m.Chat.find === 'function') {
        store.Chat = m.Chat;
      }
      if (!store.Contact && m.Contact && typeof m.Contact.get === 'function') {
        store.Contact = m.Contact;
      }
      if (!store.GroupMetadata && m.GroupMetadata && typeof m.GroupMetadata.get === 'function') {
        store.GroupMetadata = m.GroupMetadata;
      }
    }
  }

  // Convert a WhatsApp WID (Jabber ID) to a E.164-style phone number string.
  // Standard JID: "972501234567@c.us" → "+972501234567"
  // LID format:   "XXXXXXXXXX@lid"   → resolved via LidUtils (async)
  function jidToPhone(pid) {
    if (!pid) return '';
    var user = (typeof pid === 'string') ? pid.split('@')[0] : (pid.user || '');
    var server = (typeof pid === 'string') ? (pid.split('@')[1] || '') : (pid.server || '');
    if (server === 'lid') return ''; // Will be resolved separately
    return user ? ('+' + user) : '';
  }

  function getParticipantArray(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw.getModelsArray === 'function') return raw.getModelsArray();
    if (typeof raw.toArray === 'function') return raw.toArray();
    if (raw.models && Array.isArray(raw.models)) return raw.models;
    return [];
  }

  function getContactName(contact, phone) {
    if (!contact) return phone || '';
    return (
      contact.pushname ||
      contact.name ||
      contact.formattedName ||
      contact.shortName ||
      phone ||
      ''
    );
  }

  // ── Main extraction ───────────────────────────────────────────────────────

  async function extractContacts() {
    await waitForRequire();

    var store = buildStore();

    if (!store.Chat) {
      return { error: 'store_unavailable', message: 'WhatsApp store not found. Please refresh the page and try again.' };
    }

    // Find the active/open chat
    var activeChat = null;
    if (typeof store.Chat.getActive === 'function') {
      activeChat = store.Chat.getActive();
    }
    if (!activeChat && typeof store.Chat.find === 'function') {
      activeChat = store.Chat.find(function (c) { return c.active; });
    }
    if (!activeChat && store.Chat.models) {
      activeChat = store.Chat.models.find(function (c) { return c.active; });
    }

    if (!activeChat) {
      return { error: 'no_active_chat', message: 'No chat is open. Please open a WhatsApp group and try again.' };
    }

    if (!activeChat.isGroup) {
      return { error: 'not_group', message: 'The open chat is not a group. Please open a group chat and try again.' };
    }

    var groupName = activeChat.name || activeChat.formattedTitle || activeChat.subject || 'Group';
    var chatId = activeChat.id;
    var chatIdStr = (chatId && chatId._serialized) ? chatId._serialized : String(chatId || '');

    // Get group metadata
    var meta = null;
    if (store.GroupMetadata) {
      meta = store.GroupMetadata.get(chatIdStr);
    }

    // Fallback: metadata might be on activeChat itself
    if (!meta || !meta.participants) {
      if (activeChat.groupMetadata) meta = activeChat.groupMetadata;
    }

    // Try to trigger a server fetch if participants are missing
    if ((!meta || !meta.participants || getParticipantArray(meta.participants).length === 0)) {
      var queryBridge = tryRequire('WAWebGroupQueryBridge');
      if (queryBridge && typeof queryBridge.queryGroupMetadata === 'function') {
        try {
          await queryBridge.queryGroupMetadata(chatId);
          if (store.GroupMetadata) meta = store.GroupMetadata.get(chatIdStr);
        } catch (_) {}
      }
    }

    var participants = meta ? getParticipantArray(meta.participants) : [];

    if (participants.length === 0) {
      return {
        error: 'no_participants',
        message: 'No participants found. Try opening the Group Info panel first, then try again.',
      };
    }

    // Resolve participants to {name, phone, isAdmin}
    var contacts = [];
    for (var i = 0; i < participants.length; i++) {
      var p = participants[i];
      var pid = p.id;
      var pidStr = (pid && pid._serialized) ? pid._serialized : String(pid || '');
      var server = (pid && pid.server) ? pid.server : (pidStr.split('@')[1] || '');

      var phone = '';

      if (server === 'lid') {
        // LID format: resolve to real phone via LidUtils
        if (store.LidUtils) {
          try {
            var resolved = await store.LidUtils.getPhoneNumber(pid);
            if (resolved && resolved.user) phone = '+' + resolved.user;
          } catch (_) {}
        }
      } else {
        phone = jidToPhone(pid);
      }

      var contact = store.Contact ? store.Contact.get(pidStr) : null;
      // Also try the c.us JID if pid was a LID
      if (!contact && phone) {
        var cusjid = phone.replace('+', '') + '@c.us';
        contact = store.Contact ? store.Contact.get(cusjid) : null;
      }

      var name = getContactName(contact, phone);

      contacts.push({
        name: name,
        phone: phone,
        isAdmin: Boolean(p.isAdmin || p.isSuperAdmin),
      });
    }

    return {
      success: true,
      groupName: groupName,
      contacts: contacts,
    };
  }

  // ── Message listener ─────────────────────────────────────────────────────

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'WA_EXPORTER_EXTRACT') return;

    extractContacts()
      .then(function (result) {
        window.postMessage({ type: 'WA_EXPORTER_RESULT', payload: result }, '*');
      })
      .catch(function (err) {
        window.postMessage({
          type: 'WA_EXPORTER_RESULT',
          payload: { error: 'exception', message: err.message || String(err) },
        }, '*');
      });
  });
})();
