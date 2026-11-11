/** One explicit empty-input gesture. No timer, synthetic user turn, or model call on import. */
import { extension_settings, getStorageStatus } from '../../../standalone/phone-settings.js';
import { getPhoneSystem } from '../phone-system.js';
import { getPendingMessages } from './pending-operations.js';
import { saveChatMessage } from '../messages/message-chat-data.js';
import {
  beginManualReplyWrite, buildManualProactiveState, trackManualProactiveSave,
  createManualProactiveContext, manualProactiveContextIsCurrent, PROACTIVE_LOCK_NAME,
} from './proactive-scheduler.js';
import { persistCharacterExtrasTurn } from './character-extras-integration.js';
import { presentProactiveMessage } from './proactive-presenter.js';

const claims = new WeakSet();
const phoneData = () => extension_settings.acsusStandalonePhone.phone;
const uuid = () => globalThis.crypto?.randomUUID?.() || `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const knownErrors = new WeakSet();
const userError = message => {
  const error = Object.assign(new Error(message), { userMessage: message });
  knownErrors.add(error);
  return error;
};
const abortError = () => new DOMException('已停止主动回复', 'AbortError');
const ready = () => {
  const value = getStorageStatus();
  if (!value.ready || value.blocked || value.importing || value.error) throw userError('手机存储未就绪或写入未确认，请先备份并处理存储提示。');
};

function ensureEmptyTurn(phone, contactId) {
  const history = phone.chats?.[`chat_${contactId}`] || [];
  if (!Array.isArray(history)) throw userError('聊天记录格式异常，未发起请求。');
  const lastUser = history.findLastIndex(message => message?.sender === 'user');
  const unanswered = lastUser >= 0 && !history.slice(lastUser + 1).some(message => message?.sender === 'contact');
  if (getPendingMessages(contactId).length || unanswered) throw userError('出现了待回复的用户消息，请正常点击发送；没有额外发起主动请求。');
}

async function untilAborted(promise, signal) {
  let onAbort;
  const stopped = new Promise((resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([promise, stopped]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Claims foreground synchronously, before any await, so rapid clicks cannot duplicate a call. */
export async function triggerManualProactive(contactId) {
  const system = getPhoneSystem();
  const api = system?.api;
  if (!system?.enabled || !system.runtimeInitialized || !api) throw userError('手机尚未就绪。');
  if (typeof contactId !== 'string' || !contactId || ['__proto__', 'prototype', 'constructor'].includes(contactId)) throw userError('联系人标识无效。');
  if (claims.has(api) || api.isGenerating || Number(api.foregroundPending) > 0) throw userError('已有聊天请求正在处理，请等待或先停止。');
  const controller = new AbortController();
  const requestId = uuid();
  claims.add(api);
  api.foregroundPending = (Number(api.foregroundPending) || 0) + 1;
  api.isGenerating = true;
  api.currentGeneratingContactId = contactId;
  api.currentAbortController = controller;
  let endManualWrite = () => {};
  let failure = false;
  let stored = false;
  const onUser = event => { if (event.detail?.contactId === contactId) controller.abort(); };
  globalThis.addEventListener('standalone-phone-user-message-saved', onUser);
  const check = () => {
    if (controller.signal.aborted || !system.enabled || getPhoneSystem() !== system || system.api !== api
      || api.currentAbortController !== controller) throw abortError();
  };
  try {
    document.dispatchEvent(new CustomEvent('phone-ai-generation-start', { detail: { contactId } }));
    endManualWrite = await beginManualReplyWrite(); // Abort/drain background work before sharing storage.
    check();
    api.abortProactive(); // Also clears a cancelled foreground request's stale inner controller.
    api.getSettings(); // Normalize defaults BEFORE the source snapshot.
    ready();
    const phone = phoneData();
    ensureEmptyTurn(phone, contactId);
    const context = createManualProactiveContext(phone, contactId);
    if (!context.source) throw userError('该联系人已不存在。');
    // Validate the waiting-marker update before paying for a request. No mutation/I/O.
    buildManualProactiveState(phone, contactId, {
      id: requestId, proactiveRequestId: requestId, time: Math.floor(Date.now() / 1000),
    }, { countToday: false });
    const { clearDebugState, saveDebugVersion } = await import('../messages/message-debug-ui.js');
    check();
    const execute = async () => {
      check();
      ready();
      if (phoneData() !== phone || !manualProactiveContextIsCurrent(phone, contactId, context)) throw userError('聊天或设置已改变，未发起旧上下文的请求。');
      clearDebugState(contactId); // Only a dispatched manual turn clears it; never create a rollback snapshot.
      const response = await untilAborted(api.requestProactiveMessage(contactId, context.prompt, {
        signal: controller.signal, manualController: controller, requestId,
      }), controller.signal);
      check();
      const text = response?.text;
      if (typeof text !== 'string' || !text.trim()) throw userError('模型未返回可用的主动消息。');
      // Keep a validated, visible return for manual recovery even if a later write fails.
      // A replaced namespace must never receive this old profile's debug entry.
      if (phoneData() === phone) saveDebugVersion(contactId, text);
      ready();
      if (phoneData() !== phone || !manualProactiveContextIsCurrent(phone, contactId, context)) throw userError('聊天或设置已改变，未把旧回复写入当前聊天。');
      if (text === '[不发]') return { outcome: 'no-send' };
      const message = {
        id: requestId, apiCallId: response.extrasTurn?.id || requestId,
        sender: 'contact', type: 'text', content: text, time: Math.floor(Date.now() / 1000),
        proactive: true, proactiveRequestId: requestId, manualTriggered: true,
      };
      const nextState = buildManualProactiveState(phone, contactId, message, { countToday: false });
      if (nextState) phone.proactiveState = nextState;
      const finishTracking = trackManualProactiveSave(requestId);
      try {
        // The waiting marker and reply are one verified snapshot. No second unread flush.
        await saveChatMessage(contactId, message, { strict: true });
        stored = true;
      } catch (error) {
        const entry = nextState?.contacts?.[contactId];
        if (entry?.proactiveRequestId === requestId) {
          entry.lastOutcome = 'save-unconfirmed';
          entry.lastError = 'message-save-unconfirmed';
        }
        throw userError('回复写入未确认。请先导出手机备份再刷新，不要重复发送或补录。');
      } finally { finishTracking(); }
      if (phoneData() !== phone || !phone.chats?.[`chat_${contactId}`]?.some(item => item.id === requestId)) {
        throw userError('回复曾保存，但手机数据随后已更换；未在当前聊天补显旧消息。');
      }
      try {
        await persistCharacterExtrasTurn(response.extrasTurn, response.extrasBlocks,
          new Map([[contactId, new Set([message.id])]]));
      } catch { /* A sidecar failure cannot cause a second model request or duplicate the saved bubble. */ }
      try {
        if (phoneData() === phone && system.enabled) await presentProactiveMessage(contactId, message, { manual: true });
      } catch { /* Reply is already durable; opening the chat reloads saved history. */ }
      return { outcome: 'sent', message };
    };
    // Same-origin background/other-window active checks cannot overlap this explicit call.
    if (globalThis.navigator?.locks?.request) {
      return await navigator.locks.request(PROACTIVE_LOCK_NAME, { ifAvailable: true }, async lock => {
        if (!lock) throw userError('另一个窗口正在处理主动消息，请稍后再点发送。');
        return execute();
      });
    }
    // Ordinary explicit sends remain usable on non-secure origins; never enable the scheduler.
    return await execute();
  } catch (error) {
    if (error?.name === 'AbortError') return { outcome: stored ? 'sent' : 'aborted' };
    failure = true;
    if (!knownErrors.has(error)) {
      const reasons = {
        'reply-truncated': '模型输出被截断，未保存；可检查手机 API 输出上限。',
        'reply-role-mismatch': '模型回复包含其他角色，未保存。',
        'reply-format': '模型回复格式不符合主动文字要求，未保存。',
        'reply-unsupported': '模型回复包含不支持的操作内容，未保存。',
        'empty-reply': '模型没有返回文字。',
        'api-not-configured': '请先配置手机 API。',
      };
      const reason = error?.proactiveReason;
      throw userError(typeof reason === 'string' && Object.prototype.hasOwnProperty.call(reasons, reason)
        ? reasons[reason] : '主动请求未完成；请查看模型连接或手机存储提示，不会自动重试。');
    }
    throw error;
  } finally {
    globalThis.removeEventListener('standalone-phone-user-message-saved', onUser);
    if (api.currentAbortController === controller) {
      api.currentAbortController = null;
      api.isGenerating = false;
      api.currentGeneratingContactId = null;
    }
    api.foregroundPending = Math.max(0, (Number(api.foregroundPending) || 0) - 1);
    claims.delete(api);
    endManualWrite();
    if (!api.isGenerating || api.currentGeneratingContactId !== contactId) {
      document.dispatchEvent(new CustomEvent(failure ? 'phone-ai-generation-error' : 'phone-ai-generation-complete', {
        detail: { contactId, ...(failure ? { error: '手动主动请求未完成' } : {}) },
      }));
    }
  }
}
