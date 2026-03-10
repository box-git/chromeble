/**
 * injected.js – Runs in the WhatsApp Web page context (not isolated world).
 * Accesses WhatsApp's internal webpack modules to extract group participant data.
 * Communicates with content.js via window.postMessage.
 */

(function () {
  'use strict';

  // Find relevant WhatsApp Web store modules by enumerating webpack modules
  function findStores() {
    const stores = {
      Chat: null,
      Contact: null,
      GroupMetadata: null,
    };

    if (typeof window.require !== 'function' || !window.require.m) {
      return stores;
    }

    for (const id in window.require.m) {
      try {
        const mod = window.require(id);
        if (!mod || typeof mod !== 'object') continue;

        // Unwrap default export if present
        const m = mod.default && typeof mod.default === 'object' ? mod.default : mod;

        if (!stores.Chat && m.Chat && typeof m.Chat.getActive === 'function') {
          stores.Chat = m.Chat;
        }
        if (!stores.Chat && m.Chat && typeof m.Chat.find === 'function') {
          stores.Chat = m.Chat;
        }
        if (!stores.Contact && m.Contact && typeof m.Contact.get === 'function') {
          stores.Contact = m.Contact;
        }
        if (!stores.GroupMetadata && m.GroupMetadata && typeof m.GroupMetadata.get === 'function') {
          stores.GroupMetadata = m.GroupMetadata;
        }

        // Stop early if all stores found
        if (stores.Chat && stores.Contact && stores.GroupMetadata) break;
      } catch (_) {
        // Skip modules that throw on require
      }
    }

    return stores;
  }

  // Extract phone number from WhatsApp JID (e.g. "972501234567@c.us" → "+972501234567")
  function jidToPhone(jid) {
    if (!jid) return '';
    const raw = jid.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '').replace(/@.*$/, '');
    return '+' + raw;
  }

  // Get best available display name for a contact
  function getContactName(contact, phone) {
    if (!contact) return phone;
    return (
      contact.pushname ||
      contact.name ||
      contact.formattedName ||
      contact.shortName ||
      phone
    );
  }

  function extractContacts() {
    const stores = findStores();

    if (!stores.Chat) {
      return { error: 'store_unavailable', message: 'לא נמצא חנות WhatsApp. רענן את הדף ונסה שוב.' };
    }

    // Get active chat
    let activeChat = null;
    if (typeof stores.Chat.getActive === 'function') {
      activeChat = stores.Chat.getActive();
    } else if (typeof stores.Chat.find === 'function') {
      activeChat = stores.Chat.find((c) => c.active);
    }

    if (!activeChat) {
      return { error: 'no_active_chat', message: 'פתח צ\'אט קבוצה ב-WhatsApp ואז נסה שוב.' };
    }

    if (!activeChat.isGroup) {
      return { error: 'not_group', message: 'הצ\'אט הנוכחי אינו קבוצה. פתח קבוצה ונסה שוב.' };
    }

    const groupName = activeChat.name || activeChat.formattedTitle || 'קבוצה';

    // Get group metadata (participants)
    let participants = [];

    if (stores.GroupMetadata) {
      const chatId = activeChat.id && activeChat.id._serialized
        ? activeChat.id._serialized
        : String(activeChat.id);
      const groupMeta = stores.GroupMetadata.get(chatId);

      if (groupMeta && groupMeta.participants) {
        const raw = groupMeta.participants;
        if (typeof raw.getModelsArray === 'function') {
          participants = raw.getModelsArray();
        } else if (typeof raw.toArray === 'function') {
          participants = raw.toArray();
        } else if (Array.isArray(raw)) {
          participants = raw;
        } else if (raw.models) {
          participants = raw.models;
        }
      }
    }

    // Fallback: try participants from active chat directly
    if (participants.length === 0 && activeChat.groupMetadata) {
      const raw = activeChat.groupMetadata.participants;
      if (raw) {
        if (typeof raw.getModelsArray === 'function') participants = raw.getModelsArray();
        else if (Array.isArray(raw)) participants = raw;
        else if (raw.models) participants = raw.models;
      }
    }

    if (participants.length === 0) {
      return {
        error: 'no_participants',
        message: 'לא נמצאו משתתפים. ייתכן שהקבוצה טרם נטענה. נסה לפתוח את פרטי הקבוצה ואז לנסות שוב.',
      };
    }

    const contacts = participants.map((p) => {
      const jid = p.id && p.id._serialized ? p.id._serialized : String(p.id || '');
      const phone = jidToPhone(jid);
      const contact = stores.Contact ? stores.Contact.get(jid) : null;
      const name = getContactName(contact, phone);

      return {
        name,
        phone,
        isAdmin: Boolean(p.isAdmin || p.isSuperAdmin),
      };
    });

    return {
      success: true,
      groupName,
      contacts,
    };
  }

  // Listen for trigger from content.js
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'WA_EXTRACT_CONTACTS') return;

    const result = extractContacts();
    window.postMessage({ type: 'WA_CONTACTS_RESULT', payload: result }, '*');
  });
})();
