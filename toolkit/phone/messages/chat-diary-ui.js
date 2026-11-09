/**
 * 聊天日记页面
 * @module phone/messages/chat-diary-ui
 *
 * @description
 * 展示某个联系人的按天日记，支持生成、重写、删除；
 * 日记生成后会在上下文里替代原始聊天记录。
 */

import logger from '../../../logger.js';
import {
  loadDiaryEntries,
  removeDiaryEntry,
  isDiaryEnabled,
  setDiaryEnabled,
} from './chat-diary-data.js';
import { generateDiaries } from '../ai-integration/chat-diary-summarizer.js';
import { loadContacts } from '../contacts/contact-list-data.js';
import { showConfirmPopup } from '../utils/popup-helper.js';
import { showSuccessToast, showErrorToast } from '../ui-components/toast-notification.js';

let busy = false;

/**
 * 渲染聊天日记页
 *
 * @param {Object} params - 页面参数
 * @param {string} params.contactId - 联系人ID
 * @returns {Promise<DocumentFragment>} 页面片段
 */
export async function renderChatDiaryPage(params) {
  const { contactId } = params;
  logger.debug('phone', '[ChatDiary] 渲染日记页:', contactId);

  const fragment = document.createDocumentFragment();
  const container = document.createElement('div');
  container.className = 'chat-diary-page';
  container.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--phone-bg-main,#f0f0f2);';
  container.dataset.contactId = contactId;

  const contacts = await loadContacts();
  const contact = contacts.find(item => item.id === contactId);
  const contactName = contact?.name || '聊天';

  // 顶部栏
  const topBar = document.createElement('div');
  topBar.className = 'chat-settings-topbar';
  topBar.innerHTML = `
    <button class="chat-settings-back-btn" type="button"><i class="fa-solid fa-chevron-left"></i></button>
    <div class="chat-settings-title">${escapeHtml(contactName)}的日记</div>
  `;
  topBar.querySelector('.chat-settings-back-btn').addEventListener('click', handleBack);
  container.appendChild(topBar);

  // 内容区
  const content = document.createElement('div');
  content.className = 'chat-settings-content';
  content.style.cssText += 'flex:1;overflow-y:auto;padding:12px;';
  container.appendChild(content);

  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:12px;';
  toolbar.innerHTML = `
    <label style="display:flex;gap:8px;align-items:center;font-size:13px;">
      <input type="checkbox" data-role="diary-enabled">
      <span>在上下文里用日记替换原始聊天记录</span>
    </label>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button type="button" data-role="generate-missing" class="menu_button">整理没写过的日记</button>
      <button type="button" data-role="generate-all" class="menu_button">全部重写</button>
    </div>
    <div data-role="diary-status" style="font-size:12px;opacity:.8;white-space:pre-wrap;"></div>
  `;
  content.appendChild(toolbar);

  const list = document.createElement('div');
  list.dataset.role = 'diary-list';
  content.appendChild(list);

  const enabledInput = /** @type {HTMLInputElement} */ (toolbar.querySelector('[data-role="diary-enabled"]'));
  enabledInput.checked = isDiaryEnabled();
  enabledInput.addEventListener('change', async () => {
    await setDiaryEnabled(enabledInput.checked);
    setStatus(enabledInput.checked ? '已启用：历史记录会用日记替代。' : '已关闭：上下文仍发送原始聊天记录。');
  });

  toolbar.querySelector('[data-role="generate-missing"]').addEventListener('click', () => {
    void runGenerate(contactId, { regenerate: false }, list, toolbar);
  });
  toolbar.querySelector('[data-role="generate-all"]').addEventListener('click', async () => {
    const confirmed = await showConfirmPopup(
      '全部重写日记',
      '会重新调用 AI 总结每一段聊天记录，消耗额度。确定继续？',
      { okButton: '重写' },
    );
    if (!confirmed) return;
    void runGenerate(contactId, { regenerate: true }, list, toolbar);
  });

  renderEntries(list, contactId);
  fragment.appendChild(container);
  return fragment;
}

function setStatus(text) {
  const status = document.querySelector('#page-chat-diary [data-role="diary-status"]');
  if (status) status.textContent = text;
}

async function runGenerate(contactId, { regenerate }, list, toolbar) {
  if (busy) return;
  busy = true;
  const buttons = toolbar.querySelectorAll('button');
  buttons.forEach(button => { /** @type {HTMLButtonElement} */ (button).disabled = true; });
  const status = toolbar.querySelector('[data-role="diary-status"]');
  status.textContent = '正在整理…（每段聊天会单独调用一次 AI）';
  try {
    const result = await generateDiaries(contactId, {
      regenerate,
      onProgress: info => {
        status.textContent = `正在整理 ${info.date}（${info.index}/${info.total}）…`;
      },
    });
    const lines = [];
    if (result.updated.length) lines.push(`已生成：${result.updated.join('、')}`);
    if (result.skipped.length) lines.push(`跳过（消息太少）：${result.skipped.join('、')}`);
    if (result.failed.length) lines.push(`失败：${result.failed.map(item => `${item.date}（${item.error}）`).join('、')}`);
    status.textContent = lines.length ? lines.join('\n') : '没有需要整理的聊天记录。';
    if (result.updated.length) showSuccessToast(`日记已生成 ${result.updated.length} 天`);
    if (result.failed.length) showErrorToast('部分日记生成失败，可稍后重试');
    renderEntries(list, contactId);
  } catch (error) {
    logger.error('phone', '[ChatDiary] 生成日记失败:', error);
    status.textContent = `生成失败：${error?.message || error}`;
    showErrorToast('日记生成失败');
  } finally {
    busy = false;
    buttons.forEach(button => { /** @type {HTMLButtonElement} */ (button).disabled = false; });
  }
}

function renderEntries(list, contactId) {
  const entries = loadDiaryEntries(contactId);
  list.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;opacity:.7;padding:8px 0;';
    empty.textContent = '还没有日记。点“整理没写过的日记”把每天的聊天压成日记。';
    list.appendChild(empty);
    return;
  }
  for (const entry of [...entries].reverse()) {
    const item = document.createElement('div');
    item.style.cssText = 'background:#fff;border-radius:10px;padding:10px 12px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);';
    const count = entry.messageCount ? `（${entry.messageCount} 条聊天）` : '';
    item.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <strong style="font-size:14px;">${escapeHtml(entry.date)}${count}</strong>
        <div style="display:flex;gap:6px;">
          <button type="button" data-role="rewrite" style="font-size:12px;">重写</button>
          <button type="button" data-role="delete" style="font-size:12px;color:#c0392b;">删除</button>
        </div>
      </div>
      <div style="white-space:pre-wrap;line-height:1.6;font-size:13px;margin-top:8px;">${escapeHtml(entry.content)}</div>
    `;
    item.querySelector('[data-role="rewrite"]').addEventListener('click', async () => {
      const confirmed = await showConfirmPopup(
        '重写日记',
        `重写 ${entry.date} 的日记？会重新调用一次 AI。`,
        { okButton: '重写' },
      );
      if (!confirmed) return;
      setStatus(`正在重写 ${entry.date}…`);
      try {
        const result = await generateDiaries(contactId, { dates: [entry.date], regenerate: true });
        if (result.updated.length) {
          setStatus(`${entry.date} 的日记已重写。`);
          showSuccessToast(`${entry.date} 的日记已重写`);
        } else {
          setStatus(`重写失败：${result.failed[0]?.error || '未知原因'}`);
          showErrorToast(result.failed[0]?.error || '重写失败');
        }
      } catch (error) {
        setStatus(`重写失败：${error?.message || error}`);
        showErrorToast('重写失败');
      }
      renderEntries(list, contactId);
    });
    item.querySelector('[data-role="delete"]').addEventListener('click', async () => {
      const confirmed = await showConfirmPopup(
        '删除日记',
        `删除 ${entry.date} 的日记？原始聊天记录不会被删除。`,
        { danger: true, okButton: '删除' },
      );
      if (!confirmed) return;
      await removeDiaryEntry(contactId, entry.date);
      showSuccessToast('日记已删除');
      renderEntries(list, contactId);
    });
    list.appendChild(item);
  }
}

function handleBack() {
  const overlay = /** @type {HTMLElement} */ (document.querySelector('.phone-overlay'));
  import('../phone-main-ui.js').then(({ hidePage }) => hidePage(overlay, 'chat-diary'));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
