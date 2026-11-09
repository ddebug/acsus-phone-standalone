/**
 * 聊天日记页面
 * @module phone/messages/chat-diary-ui
 *
 * @description
 * 按天展示待总结、消息太少而跳过的日期及已有日记；
 * 每次生成操作只提交一个请求，原始聊天记录始终保留。
 */

import logger from '../../../logger.js';
import {
  DIARY_SKIP_THRESHOLD,
  getDiaryDayStatuses,
  loadDiaryEntries,
  removeDiaryEntry,
  isDiaryEnabled,
  setDiaryEnabled,
} from './chat-diary-data.js';
import { loadChatHistory } from './message-chat-data.js';
import { generateDiaries } from '../ai-integration/chat-diary-summarizer.js';
import { loadContacts } from '../contacts/contact-list-data.js';
import { showConfirmPopup } from '../utils/popup-helper.js';
import { showSuccessToast, showErrorToast } from '../ui-components/toast-notification.js';

// 确认弹窗、生成、删除和设置共用同一把锁，跨页面实例也不能重叠操作。
let busy = false;
const views = new WeakMap();

/**
 * 渲染聊天日记页
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

  let contactName = '聊天';
  try {
    const contacts = await loadContacts();
    contactName = contacts.find(item => item.id === contactId)?.name || contactName;
  } catch (error) {
    logger.error('phone', '[ChatDiary] 读取联系人失败:', error);
  }

  const topBar = document.createElement('div');
  topBar.className = 'chat-settings-topbar';
  topBar.innerHTML = `
    <button class="chat-settings-back-btn" type="button"><i class="fa-solid fa-chevron-left"></i></button>
    <div class="chat-settings-title">${escapeHtml(contactName)}的日记</div>
  `;
  topBar.querySelector('.chat-settings-back-btn').addEventListener('click', handleBack);
  container.appendChild(topBar);

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
    <div style="font-size:12px;line-height:1.6;opacity:.8;">每次总结仅发送一次 API 请求，携带完整聊天历史。每天 ≤${DIARY_SKIP_THRESHOLD} 条消息的日期跳过，不删除原始聊天。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button type="button" data-role="generate-missing" class="menu_button">一键总结全部待总结（一次 API 请求）</button>
      <button type="button" data-role="generate-all" class="menu_button">全部重写（一次 API 请求）</button>
    </div>
    <div data-role="diary-status" role="status" aria-live="polite" style="font-size:12px;opacity:.8;white-space:pre-wrap;">正在读取日期状态…</div>
  `;
  content.appendChild(toolbar);

  const dayStatuses = document.createElement('div');
  dayStatuses.dataset.role = 'diary-day-statuses';
  dayStatuses.style.cssText = 'margin-bottom:16px;font-size:13px;line-height:1.7;';
  content.appendChild(dayStatuses);

  const list = document.createElement('div');
  list.dataset.role = 'diary-list';
  content.appendChild(list);

  const enabledInput = /** @type {HTMLInputElement} */ (toolbar.querySelector('[data-role="diary-enabled"]'));
  const ui = { container, contactId, toolbar, dayStatuses, list, enabledInput, loading: true, dataReady: false };
  views.set(container, ui);
  enabledInput.checked = isDiaryEnabled();
  enabledInput.addEventListener('change', () => {
    const enabled = enabledInput.checked;
    if (busy) {
      enabledInput.checked = isDiaryEnabled();
      return;
    }
    void runAction(ui, async () => {
      await setDiaryEnabled(enabled);
      setStatus(ui, enabled ? '已启用：历史记录会用日记替代。' : '已关闭：上下文仍发送原始聊天记录。');
    }, { failureText: '日记设置保存失败' });
  });

  toolbar.querySelector('[data-role="generate-missing"]').addEventListener('click', () => {
    if (!ui.dataReady || ui.loading) return;
    void runGenerate(ui, { dates: null, regenerate: false });
  });
  toolbar.querySelector('[data-role="generate-all"]').addEventListener('click', () => {
    if (!ui.dataReady || ui.loading) return;
    void runGenerate(ui, { dates: null, regenerate: true }, {
      title: '全部重写日记',
      message: `将用完整聊天历史，在一次 API 请求中重写全部符合条件的日期（每天 >${DIARY_SKIP_THRESHOLD} 条消息），覆盖已有日记并消耗额度。原始聊天不会删除，确定继续？`,
    });
  });

  try {
    await refreshView(ui);
    setStatus(ui, '日期状态已加载；可一键总结全部待总结日期。');
  } catch (error) {
    reportError(ui, '日期状态读取失败', error);
  }
  fragment.appendChild(container);
  return fragment;
}

function setStatus(ui, text) {
  ui.toolbar.querySelector('[data-role="diary-status"]').textContent = text;
}

function syncControls(current) {
  const containers = new Set(document.querySelectorAll('.chat-diary-page'));
  containers.add(current.container);
  for (const container of containers) {
    const ui = views.get(container);
    if (!ui) continue;
    for (const control of container.querySelectorAll('button, input')) {
      control.disabled = busy || ui.loading || control.dataset.unavailable === 'true';
    }
  }
}

function reportError(ui, label, error) {
  logger.error('phone', `[ChatDiary] ${label}:`, error);
  setStatus(ui, `${label}：${error?.message || error}`);
  showErrorToast(label);
}

async function runAction(ui, action, { refresh = false, failureText = '操作失败' } = {}) {
  if (busy || ui.loading) return;
  busy = true;
  syncControls(ui);
  try {
    await action();
  } catch (error) {
    reportError(ui, failureText, error);
  } finally {
    try {
      if (refresh) {
        try {
          await refreshView(ui);
        } catch (error) {
          logger.error('phone', '[ChatDiary] 刷新日期状态失败:', error);
          const status = ui.toolbar.querySelector('[data-role="diary-status"]');
          status.textContent += `\n日期状态刷新失败：${error?.message || error}`;
          showErrorToast('日期状态刷新失败，请重新打开日记页');
        }
      }
      ui.enabledInput.checked = isDiaryEnabled();
    } finally {
      busy = false;
      syncControls(ui);
    }
  }
}

async function runGenerate(ui, { dates, regenerate }, confirmation) {
  await runAction(ui, async () => {
    if (confirmation) {
      const confirmed = await showConfirmPopup(confirmation.title, confirmation.message, { okButton: '重写' });
      if (!confirmed) return;
    }
    setStatus(ui, '正在准备完整聊天历史（本次操作仅发送一次 API 请求）…');
    const result = await generateDiaries(ui.contactId, {
      dates,
      regenerate,
      onProgress: info => {
        const stages = {
          preparing: '正在准备完整聊天历史',
          requesting: '正在发送一次 API 请求并等待全部日记',
          saving: '正在保存日记',
        };
        const targetDates = Array.isArray(info.dates) ? info.dates : [];
        const total = info.total ?? targetDates.length;
        setStatus(ui, `${stages[info.stage] || '正在整理日记'}（${total} 天）…${targetDates.length ? `\n目标日期：${targetDates.join('、')}` : ''}`);
      },
    });
    const lines = [];
    if (result.updated.length) lines.push(`已生成 ${result.updated.length} 天：${result.updated.join('、')}`);
    if (result.skipped.length) lines.push(`跳过（每天 ≤${DIARY_SKIP_THRESHOLD} 条消息）：${result.skipped.join('、')}`);
    if (result.failed.length) lines.push(`失败：${result.failed.map(item => `${item.date}（${item.error}）`).join('、')}`);
    setStatus(ui, lines.length ? lines.join('\n') : '没有需要整理的日期。');
    if (result.updated.length) showSuccessToast(`日记已生成 ${result.updated.length} 天`);
    if (result.failed.length) showErrorToast('部分日记生成失败，可稍后重试');
  }, { refresh: true, failureText: '日记生成失败' });
}

async function refreshView(ui) {
  ui.loading = true;
  ui.dataReady = false;
  syncControls(ui);
  try {
    // 先展示已有日记；即使历史读取失败，也保留可见的日记内容。
    renderEntries(ui, loadDiaryEntries(ui.contactId));
    syncControls(ui);
    const messages = await loadChatHistory(ui.contactId);
    const entries = loadDiaryEntries(ui.contactId);
    const statuses = getDiaryDayStatuses(messages, entries);
    renderDayStatuses(ui, statuses);
    renderEntries(ui, entries);
    ui.dataReady = true;
  } finally {
    ui.loading = false;
    if (!ui.dataReady) {
      ui.dayStatuses.textContent = '日期状态暂不可用，请重新打开日记页。';
      ui.toolbar.querySelector('[data-role="generate-missing"]').dataset.unavailable = 'true';
      ui.toolbar.querySelector('[data-role="generate-all"]').dataset.unavailable = 'true';
    }
    syncControls(ui);
  }
}

function renderDayStatuses(ui, statuses) {
  const pending = statuses.filter(day => day.status === 'pending');
  const skipped = statuses.filter(day => day.status === 'skipped');
  const summarized = statuses.filter(day => day.status === 'summarized');
  ui.dayStatuses.innerHTML = '';

  const summary = document.createElement('div');
  summary.textContent = `待总结 ${pending.length} 天 · 已总结 ${summarized.length} 天 · 消息太少跳过 ${skipped.length} 天`;
  summary.style.cssText = 'font-weight:600;margin-bottom:8px;';
  ui.dayStatuses.appendChild(summary);
  appendDateGroup(ui.dayStatuses, `待总结日期（${pending.length} 天）`, pending, '当前没有待总结日期。');
  appendDateGroup(ui.dayStatuses, `跳过日期（每天 ≤${DIARY_SKIP_THRESHOLD} 条消息，共 ${skipped.length} 天）`, skipped, '没有因消息太少而跳过的日期。');

  const missingButton = ui.toolbar.querySelector('[data-role="generate-missing"]');
  missingButton.textContent = `一键总结全部待总结（${pending.length} 天 / 一次 API 请求）`;
  missingButton.dataset.unavailable = String(pending.length === 0);
  ui.toolbar.querySelector('[data-role="generate-all"]').dataset.unavailable = String(!statuses.some(day => day.messageCount > DIARY_SKIP_THRESHOLD));
}

function appendDateGroup(parent, title, days, emptyText) {
  const section = document.createElement('section');
  section.style.cssText = 'background:var(--phone-bg-card,#fff);border-radius:10px;padding:10px 12px;margin-bottom:8px;';
  const heading = document.createElement('strong');
  heading.textContent = title;
  section.appendChild(heading);
  if (!days.length) {
    const empty = document.createElement('div');
    empty.style.opacity = '.7';
    empty.textContent = emptyText;
    section.appendChild(empty);
  }
  for (const day of days) {
    const row = document.createElement('div');
    row.textContent = `${day.date} · ${day.messageCount} 条消息${day.status === 'skipped' ? ' · 跳过，不生成日记' : ' · 待总结'}`;
    section.appendChild(row);
  }
  parent.appendChild(section);
}

function renderEntries(ui, entries) {
  ui.list.innerHTML = '';
  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:8px;';
  heading.textContent = `已有日记（${entries.length} 天）`;
  ui.list.appendChild(heading);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;opacity:.7;padding:8px 0;';
    empty.textContent = '还没有日记。上方可查看待总结日期，并一次请求生成全部日记。';
    ui.list.appendChild(empty);
    return;
  }
  for (const entry of [...entries].reverse()) {
    const item = document.createElement('div');
    item.style.cssText = 'background:var(--phone-bg-card,#fff);border-radius:10px;padding:10px 12px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);';
    const count = entry.messageCount != null ? `（${escapeHtml(entry.messageCount)} 条聊天）` : '';
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
    item.querySelector('[data-role="rewrite"]').addEventListener('click', () => {
      void runGenerate(ui, { dates: [entry.date], regenerate: true }, {
        title: '重写日记',
        message: `重写 ${entry.date} 的日记？将携带完整聊天历史，只生成这一天，并仅调用一次 API。每天 ≤${DIARY_SKIP_THRESHOLD} 条消息时跳过。`,
      });
    });
    item.querySelector('[data-role="delete"]').addEventListener('click', () => {
      void runAction(ui, async () => {
        const confirmed = await showConfirmPopup(
          '删除日记',
          `删除 ${entry.date} 的日记？只删除日记，原始聊天记录不会被删除；符合条件的日期会重新显示为待总结。`,
          { danger: true, okButton: '删除' },
        );
        if (!confirmed) return;
        const removed = await removeDiaryEntry(ui.contactId, entry.date);
        setStatus(ui, removed ? `${entry.date} 的日记已删除，原始聊天保留。` : `${entry.date} 的日记已不存在。`);
        if (removed) showSuccessToast('日记已删除，原始聊天保留');
      }, { refresh: true, failureText: '删除日记失败' });
    });
    ui.list.appendChild(item);
  }
}

async function handleBack() {
  if (busy) return;
  try {
    const overlay = /** @type {HTMLElement} */ (document.querySelector('.phone-overlay'));
    const { hidePage } = await import('../phone-main-ui.js');
    hidePage(overlay, 'chat-diary');
  } catch (error) {
    logger.error('phone', '[ChatDiary] 返回失败:', error);
    showErrorToast('返回失败，请稍后重试');
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
