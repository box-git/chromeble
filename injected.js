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

  // Version-based guard: bump when the script changes so extension updates
  // take effect without requiring the user to refresh the WhatsApp Web tab.
  var SCRIPT_VERSION = 'v5';
  if (window.__waExporterVersion === SCRIPT_VERSION) return;
  window.__waExporterVersion = SCRIPT_VERSION;

  // Remove the previous version's listener to avoid stacking handlers.
  if (typeof window.__waExporterHandler === 'function') {
    window.removeEventListener('message', window.__waExporterHandler);
    window.__waExporterHandler = null;
  }

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

  // Determine if a chat object represents a WhatsApp group.
  // Groups always have a JID ending in @g.us. The isGroup boolean
  // is not reliably present on all WhatsApp Web versions.
  function detectIsGroup(chat) {
    if (chat.isGroup === true || chat.isGroupChat === true) return true;

    // Also check: only groups have groupMetadata / participants
    if (chat.groupMetadata || chat.participants) return true;

    // Inspect the JID — works whether id is an object or a plain string
    var id = chat.id;
    if (!id) return false;

    if (typeof id === 'string') {
      return id.indexOf('@g.us') !== -1;
    }

    // WID object
    if (id.server === 'g.us') return true;
    var serialized = id._serialized || '';
    return serialized.indexOf('@g.us') !== -1;
  }

  // Serialise a WID to its full JID string
  function serialiseId(id) {
    if (!id) return '';
    if (typeof id === 'string') return id;
    if (id._serialized) return id._serialized;
    if (id.user && id.server) return id.user + '@' + id.server;
    return String(id);
  }

  // Extract phone number from a JID/WID (non-LID)
  function jidToPhone(pid) {
    if (!pid) return '';
    var user = (typeof pid === 'string') ? pid.split('@')[0] : (pid.user || '');
    var server = (typeof pid === 'string') ? (pid.split('@')[1] || '') : (pid.server || '');
    if (server === 'lid') return '';
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
      var models = Array.isArray(store.Chat.models)
        ? store.Chat.models
        : (typeof store.Chat.models.find === 'function' ? store.Chat.models : []);
      activeChat = models.find ? models.find(function (c) { return c.active; }) : null;
    }

    if (!activeChat) {
      return { error: 'no_active_chat', message: 'No chat is open. Please open a WhatsApp group and try again.' };
    }

    if (!detectIsGroup(activeChat)) {
      return { error: 'not_group', message: 'The open chat is not a group. Please open a group chat and try again.' };
    }

    var groupName = activeChat.name || activeChat.formattedTitle || activeChat.subject || 'Group';
    var chatId = activeChat.id;
    var chatIdStr = serialiseId(chatId);

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
    if (!meta || !meta.participants || getParticipantArray(meta.participants).length === 0) {
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
      var pidStr = serialiseId(pid);
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

  window.__waExporterHandler = function (event) {
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
  };

  window.addEventListener('message', window.__waExporterHandler);
})();
