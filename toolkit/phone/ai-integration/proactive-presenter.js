/** Present only a durably saved proactive message. Never saves or increments unread twice. */
import logger from '../../../logger.js';
import { loadContacts } from '../contacts/contact-list-data.js';
import { getContactDisplayName } from '../utils/contact-display-helper.js';
import { getPhoneSystem } from '../phone-system.js';
import { showPhoneMessageNotification } from '../ui-components/toast-notification.js';

const html = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export async function presentProactiveMessage(contactId, message) {
  const hour = new Date().getHours();
  if (!getPhoneSystem()?.enabled || (hour >= 1 && hour < 9)) return;
  const contact = (await loadContacts()).find(item => item.id === contactId);
  if (!contact) return;
  // Storage already contains the message; rendering is best effort, never retried as a send.
  try {
    const id = `page-chat-${contactId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const page = document.getElementById(id);
    if (page?.isConnected) {
      const { appendMessageToChat } = await import('../messages/message-chat-ui.js');
      await appendMessageToChat(page, message, contact, contactId);
    }
  } catch { logger.warn('phone', '[Proactive] 消息已保存，界面将在重新打开聊天后更新'); }
  document.dispatchEvent(new CustomEvent('phone-message-received', { detail: { contactId, message } }));
  const notifyHour = new Date().getHours();
  if (contact.notificationDisabled === true || !getPhoneSystem()?.enabled || (notifyHour >= 1 && notifyHour < 9)) return;
  // The shared notification renderer uses HTML internally: escape untrusted generated text.
  showPhoneMessageNotification({
    contactId,
    characterName: html(getContactDisplayName(contact)),
    content: contact.notificationPreview === false ? '发来了新消息' : html(message.content),
    onClick: () => {
      void (async () => {
        const { openPhoneUI } = await import('../index.js');
        const overlay = await openPhoneUI();
        if (!overlay) return;
        const { showPage } = await import('../phone-main-ui.js');
        await showPage(overlay, 'chat', { contactId });
      })().catch(() => logger.warn('phone', '[Proactive] 请从手机消息列表打开聊天'));
    },
  });
}
