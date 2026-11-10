/** One-request sidecar plumbing. No old extras are read into prompts/history. */
import { extension_settings } from '../../../standalone/phone-settings.js';
import { loadContacts } from '../contacts/contact-list-data.js';
import {
  getCharacterExtrasSettings, buildCharacterExtrasPrompt,
  splitCharacterExtras, saveCharacterExtras,
} from '../messages/character-extras-data.js';
import { showWarningToast } from '../ui-components/toast-notification.js';

/** Capture opt-in and identity once; caller strips reserved blocks even when disabled. */
export async function prepareCharacterExtrasTurn(messages, contactId, allPendingMessages = {}, { toolMode = false, id } = {}) {
  const settings = getCharacterExtrasSettings();
  const ids = new Set([contactId, ...Object.entries(allPendingMessages)
    .filter(([, values]) => Array.isArray(values) && values.length).map(([key]) => key)]);
  const contacts = (await loadContacts()).filter(contact => ids.has(contact.id))
    .map(contact => ({ id: contact.id, name: contact.name }));
  const turn = {
    id: id || globalThis.crypto.randomUUID(),
    phone: extension_settings.acsusStandalonePhone.phone,
    settings: JSON.stringify(settings), enabled: settings.enabled === true,
    contacts, finished: false,
  };
  if (turn.enabled) {
    const prompt = buildCharacterExtrasPrompt(contacts, { toolMode });
    if (prompt) messages.push({ role: 'system', content: prompt });
  }
  return turn;
}

export { splitCharacterExtras };

/** A sidecar is saved only for roles with actual saved replies from THIS response. */
export async function persistCharacterExtrasTurn(turn, blocks, delivered) {
  if (!turn || turn.finished) return;
  turn.finished = true; // failed/uncertain writes are never automatically retried.
  if (!turn.enabled || !Array.isArray(blocks) || !blocks.length || !delivered?.size ||
      extension_settings.acsusStandalonePhone.phone !== turn.phone ||
      getCharacterExtrasSettings().enabled !== true) return;
  const currentContacts = await loadContacts();
  const groups = new Map();
  for (const block of blocks) {
    const matches = turn.contacts.filter(contact => contact.id === block.role || contact.name === block.role);
    if (matches.length !== 1) continue;
    const contact = matches[0];
    if (!delivered.has(contact.id) || !currentContacts.some(item => item.id === contact.id)) continue;
    const group = groups.get(contact.id) || [];
    group.push(block);
    groups.set(contact.id, group);
  }
  for (const [contactId, entries] of groups) {
    // Ambiguous duplicate role blocks are not guessed/merged and cannot overwrite each other.
    if (entries.length !== 1) continue;
    try {
      await saveCharacterExtras(contactId, {
        id: turn.id, time: Date.now(),
        sections: entries[0].sections, sourceMessageIds: [...delivered.get(contactId)],
      }, { expectedPhone: turn.phone });
    } catch {
      showWarningToast('聊天回复已保留，但角色小剧场未确认保存，请查看手机存储提示。');
      return;
    }
  }
}

/** Use the same strict protocol parser for structured tool arguments. */
export function extrasBlockFromTool(call) {
  try {
    return splitCharacterExtras(`<phone-extras>${JSON.stringify({
      role: call.arguments?.contact_name, sections: call.arguments?.sections,
    })}</phone-extras>`).blocks;
  } catch { return []; }
}
