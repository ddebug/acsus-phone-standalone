/** User-confirmed, text-only recovery. Never calls a model or the AI operation parser. */
import { extension_settings, saveSettingsDebounced, flushPhoneStorage, getStorageStatus } from '../../../standalone/phone-settings.js';
import { loadContacts } from '../contacts/contact-list-data.js';
import { splitCharacterExtras } from './character-extras-data.js';
import { isManualReplyRoleName } from './manual-reply-role-names.js';
import { buildManualProactiveState, trackManualProactiveSave, beginManualReplyWrite } from '../ai-integration/proactive-scheduler.js';
import { getPhoneSystem } from '../phone-system.js';

const plans = new WeakMap();
let saveQueue = Promise.resolve();
const uuid = () => globalThis.crypto?.randomUUID?.() || `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const phoneData = () => extension_settings.acsusStandalonePhone.phone;
const busy = () => Boolean(getPhoneSystem()?.api?.isGenerating || getPhoneSystem()?.api?.foregroundPending);
const ready = () => {
  const status = getStorageStatus();
  if (!status.ready || status.blocked || status.importing || status.error) throw new Error('手机存储尚未就绪；请先保留备份并处理存储提示。');
};
const preflightError = message => {
  const error = new Error(message);
  error.manualReplyPreflight = true;
  return error;
};
const dateKey = time => {
  const value = new Date(time * 1000);
  return `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
};
const historyOf = (phone, contactId) => {
  if (!phone || typeof phone !== 'object') throw new Error('手机存储尚未准备好。');
  if (phone.chats !== undefined && (!phone.chats || typeof phone.chats !== 'object' || Array.isArray(phone.chats))) throw new Error('现有聊天存储格式异常，未覆盖原数据。');
  const value = phone.chats?.[`chat_${contactId}`];
  if (value !== undefined && !Array.isArray(value)) throw new Error('现有聊天格式异常，未改动原记录。');
  return value || [];
};

function extractText(raw, contact) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 128000) throw new Error('请只粘贴该角色的回复正文（最多128000字符），不要粘贴整份日志。');
  const separated = splitCharacterExtras(raw.replace(/\r\n?/g, '\n'));
  const warnings = [];
  if (separated.blocks.length || separated.issues.length || /<\/?phone-extras/i.test(raw)) warnings.push('小剧场包裹已隔离；此入口只补聊天文字，不补录小剧场。');
  let text = separated.text;
  if (/<(?:think|thinking|analysis|reasoning)\b/i.test(text)) {
    text = text.replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<(?:think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*$/gi, '');
    warnings.push('思考块已移除；只会保存预览中的最终文字。');
  }
  text = text.trim().replace(/^```(?:text|plaintext|json)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim();
  // This is deliberately NOT an API-response importer. Be conservative about
  // envelopes (including Claude content-before-role and prefixed SSE packets).
  if (/^\s*(?:\{|"[\[{]|\[\s*(?:\{|"|\[|\]|null\b|true\b|false\b|-?\d))/i.test(text)
    || /(?:\\*")(?:choices|candidates|api_key|messages|authorization|reasoning_content|reasoning|thinking|tool_calls|functionCall|function_call|arguments)(?:\\*")\s*:/i.test(text)
    || (/"role"\s*:\s*"(?:system|assistant|user)"/i.test(text) && /"content"\s*:/i.test(text))
    || /^\s*(?:data\s*:|curl\b|(?:GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/|\/))/im.test(text)
    || /\b(?:proxy-authorization|authorization|x-(?:goog-)?api-key|api[_ -]?key)\b["']?\s*[:=]/i.test(text)) {
    throw new Error('这看起来是 API 日志或结构化数据。请只复制最终回复正文，不要复制请求、密钥或思考过程。');
  }
  const roles = [...text.matchAll(/\[角色-([^\]]+)\]/g)];
  if (roles.length) {
    const roleNames = [...new Set(roles.map(match => match[1].trim()).filter(Boolean))];
    const otherNames = roleNames.filter(name => !isManualReplyRoleName(contact, name));
    if (otherNames.length) {
      const display = otherNames.slice(0, 4).join('、');
      throw new Error(`只能补录当前角色的回复；日志中出现了其他角色（${display}）。请只复制当前角色的那一段，或只粘贴普通正文。`);
    }
    const prefix = text.slice(0, roles[0].index).trim();
    if (prefix) throw new Error('角色标签前还有其他内容，请只复制最终回复。');
    const bodies = roles.map((role, index) => text.slice(
      role.index + role[0].length,
      index + 1 < roles.length ? roles[index + 1].index : text.length,
    ));
    const messageBlocks = bodies.flatMap(body => [...body.matchAll(/\[消息\]([\s\S]*?)(?:\[\/消息\]|(?=\[\/角色-)|$)/g)]);
    if (messageBlocks.length) {
      text = messageBlocks.map(match => match[1].trim()).filter(Boolean).join('\n');
      warnings.push('普通角色/消息标签已去除；预览内容会保存为一条文字气泡。');
    } else {
      // A log may omit [消息] while still carrying a role envelope. Keep the
      // body when it is plain text; bare labels are rejected below.
      text = bodies.map(body => body.replace(/\[\/角色-[^\]]*\]\s*$/, '').trim()).filter(Boolean).join('\n');
      if (!text) throw new Error('未找到普通消息正文，请只复制消息里的文字。');
      warnings.push('角色标签已去除；预览内容会保存为一条文字气泡。');
    }
  } else {
    text = text.replace(/^\[消息\]([\s\S]*?)(?:\[\/消息\])?\s*$/, '$1').trim();
  }
  // Operations belong to the caller's response pipeline, not this text-only
  // recovery. Ignore them when they sit outside a [消息] block, but never save
  // them as chat text if they were placed inside the message body.
  const operation = text.match(/\[(?:系统(?:[:：][^\]]*)?|操作-[^\]]*|空间动态|转账|红包|约定计划|好友申请|改个签|开会员|送会员)\]/);
  if (operation) {
    throw new Error(`含有操作或非文字标签“${operation[0]}”。请删除该标签后重新预览；这里不会执行转账、好友、计划等操作。`);
  }
  if (!text || text === '[不发]' || text.length > 32000) throw new Error('没有可补录的文字，或正文超过32000字符；[不发]不能补成角色消息。');
  if (/<\/?(?:think|thinking|analysis|reasoning|phone-extras)\b/i.test(text) || /\[\/?(?:角色-|消息\])/.test(text)) throw new Error('仍有未识别标签，请只保留普通文字后重新预览。');
  return { text, warnings };
}

/** Pure preview plus in-memory duplicate lookup. Preview does not write storage. */
export async function previewManualReply(contactId, raw, { time, proactive = true } = {}) {
  if (typeof contactId !== 'string' || !contactId || ['__proto__', 'prototype', 'constructor'].includes(contactId)) throw new Error('联系人标识无效。');
  if (busy()) throw new Error('有聊天正在生成，请先停止或等待完成，再补录。');
  if (!Number.isSafeInteger(time) || time <= 0 || time > Math.floor(Date.now() / 1000) + 60) throw new Error('请填写有效的本地消息时间，不能填未来时间。');
  if (typeof proactive !== 'boolean') throw new Error('主动回复标记无效。');
  const contact = (await loadContacts()).find(item => item.id === contactId);
  if (!contact) throw new Error('该联系人已不存在。');
  const phone = phoneData();
  const { text, warnings } = extractText(raw, contact);
  const duplicate = historyOf(phone, contactId).findLast(message => message.sender === 'contact' && message.type === 'text' && String(message.content || '').trim() === text);
  if (proactive) {
    buildManualProactiveState(phone, contactId, { id: 'preview', proactiveRequestId: 'preview', time });
    warnings.push(dateKey(time) !== dateKey(Date.now() / 1000)
      ? '历史日期的补录不占今天额度；若已有更晚的用户发言，不会锁住当前主动消息资格。'
      : '新增主动补录会保守占用今天1条额度；若没有更晚的用户发言，会等你回复再继续主动。不消耗模型尝试次数。');
  }
  const preview = Object.freeze({ contactId, text, time, proactive, warnings: Object.freeze(warnings), duplicate: duplicate ? Object.freeze({ id: duplicate.id, time: duplicate.time }) : null });
  plans.set(preview, { phone, contactName: contact.name, id: uuid(), status: 'ready' });
  return preview;
}

/** Display only a currently saved record; failures cannot turn a successful write into a retry. */
async function publishManualReply(phone, contactId, messageId) {
  try {
    if (phoneData() !== phone) return false;
    const { appendMessageToChat } = await import('./message-chat-ui.js');
    const message = historyOf(phone, contactId).find(item => item.id === messageId);
    const contact = (await loadContacts()).find(item => item.id === contactId);
    if (!message || !contact || phoneData() !== phone) return false;
    document.dispatchEvent(new CustomEvent('phone-message-received', { detail: { contactId, message } }));
    const page = document.getElementById(`page-chat-${contactId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    if (!page?.isConnected) return true; // A fresh page loads the saved history normally.
    const nodes = () => new Map([...page.querySelectorAll('[data-msg-id]')].map(node => [node.dataset.msgId, node]));
    if (!nodes().has(messageId)) {
      getPhoneSystem()?.api?.resetRenderedState(contactId);
      await appendMessageToChat(page, message, contact, contactId);
    }
    const current = historyOf(phone, contactId);
    const map = nodes();
    const bubble = map.get(messageId);
    if (!current.some(item => item.id === messageId)) { bubble?.remove(); return false; }
    // Backdated recovery belongs before the next already-rendered saved message.
    const position = current.findIndex(item => item.id === messageId);
    const following = current.slice(position + 1).map(item => map.get(item.id)).find(node => node?.parentNode === bubble?.parentNode);
    if (bubble && following) bubble.parentNode.insertBefore(bubble, following);
    return Boolean(bubble);
  } catch { return false; }
}

/** One immutable preview = one stable message ID. Unknown writes are not retried. */
export function commitManualReply(preview, { allowDuplicate = false } = {}) {
  const plan = plans.get(preview);
  if (!plan || plan.status !== 'ready') return Promise.reject(preflightError('此预览已使用、正在保存或结果未确认；请重新预览。'));
  plan.status = 'saving';
  const operation = saveQueue.then(async () => {
    let endManualWrite = () => {};
    try {
      endManualWrite = await beginManualReplyWrite();
    } catch (error) {
      error.manualReplyPreflight = true;
      throw error;
    }
    try {
    try { ready(); } catch (error) { error.manualReplyPreflight = true; throw error; }
    if (busy()) throw preflightError('有聊天正在生成，未补录。');
    if (phoneData() !== plan.phone) throw preflightError('手机数据已更换，请重新预览。');
    const phone = plan.phone;
    const contact = (await loadContacts()).find(item => item.id === preview.contactId);
    if (!contact || contact.name !== plan.contactName) throw preflightError('联系人已变化，请重新预览。');
    if (phoneData() !== phone) throw preflightError('手机数据已更换，未补录。');
    let old;
    try { old = historyOf(phone, preview.contactId); } catch (error) { error.manualReplyPreflight = true; throw error; }
    const sameText = old.findLast(message => message.sender === 'contact' && message.type === 'text' && String(message.content || '').trim() === preview.text);
    const exact = old.findLast(message => message.sender === 'contact' && message.type === 'text'
      && String(message.content || '').trim() === preview.text && Number(message.time) === preview.time);
    if (exact) {
      await flushPhoneStorage(); // An in-memory match alone is not a persistence receipt.
      ready();
      if (phoneData() !== phone || !historyOf(phone, preview.contactId).includes(exact)) throw new Error('已有记录发生变化，未重复补录。');
      plan.status = 'saved';
      const displayed = exact.id ? await publishManualReply(phone, preview.contactId, exact.id) : false;
      return { message: exact, alreadyExists: true, displayPending: !displayed };
    }
    if (sameText && !allowDuplicate) throw preflightError('已有相同文字，请重新预览并确认是否真的需要另一条。');
    const message = { id: plan.id, apiCallId: plan.id, sender: 'contact', type: 'text', content: preview.text, time: preview.time, manualRecovered: true };
    if (preview.proactive) { message.proactive = true; message.proactiveRequestId = plan.id; }
    const index = old.findIndex(item => Number.isFinite(Number(item.time)) && Number(item.time) > message.time);
    const at = index < 0 ? old.length : index;
    const next = [...old.slice(0, at), message, ...old.slice(at)];
    const chats = phone.chats || {};
    const shadow = { ...phone, chats: { ...chats, [`chat_${preview.contactId}`]: next } };
    let nextState;
    try { nextState = preview.proactive ? buildManualProactiveState(shadow, preview.contactId, message) : null; }
    catch (error) { error.manualReplyPreflight = true; throw error; }
    const previousState = phone.proactiveState;
    phone.chats = shadow.chats;
    if (nextState) phone.proactiveState = nextState;
    const finishTracking = nextState ? trackManualProactiveSave(plan.id) : () => {};
    try {
      let pending;
      try { pending = saveSettingsDebounced(); }
      catch (error) {
        if (error?.code === 'NOT_READY' || error?.code === 'IMPORT_BUSY') error.manualReplyPreflight = true;
        throw error;
      }
      try {
        await Promise.all([pending, flushPhoneStorage()]);
      } catch (error) {
        if (error?.code === 'NOT_READY' || error?.code === 'IMPORT_BUSY') error.manualReplyPreflight = true;
        throw error;
      }
      if (phoneData() !== phone || phone.chats?.[`chat_${preview.contactId}`] !== next || !next.some(item => item.id === message.id)) throw new Error('保存期间数据已更换，补录结果未确认。');
      plan.status = 'saved';
      finishTracking();
      const displayed = await publishManualReply(phone, preview.contactId, message.id);
      return { message, alreadyExists: false, displayPending: !displayed };
    } catch (error) {
      if (error?.manualReplyPreflight) {
        // Nothing was written. Restore only our own in-memory insertion so a
        // later unrelated save cannot persist a reply the UI reported as failed.
        if (phone.chats?.[`chat_${preview.contactId}`] === next) phone.chats[`chat_${preview.contactId}`] = old;
        if (nextState && phone.proactiveState === nextState) phone.proactiveState = previousState;
        plan.status = 'failed';
        throw error;
      }
      // Keep the reply available for in-memory backup; never append it again.
      plan.status = 'unconfirmed';
      const marker = nextState?.contacts?.[preview.contactId];
      if (marker?.proactiveRequestId === plan.id) {
        marker.lastOutcome = 'save-unconfirmed';
        marker.lastError = 'message-save-unconfirmed';
      }
      throw error;
    } finally { finishTracking(); }
    } finally { endManualWrite(); }
  });
  saveQueue = operation.catch(() => {});
  return operation.catch(error => { if (plan.status === 'saving') plan.status = 'failed'; throw error; });
}
