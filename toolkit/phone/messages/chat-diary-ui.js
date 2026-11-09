/** 聊天日记：可编辑提示词、按日多选及聊天文本 token 估算。 */
import logger from '../../../logger.js';
import {
  DIARY_SKIP_THRESHOLD, getDiaryDayStatuses, loadDiaryEntries, removeDiaryEntry,
  isDiaryEnabled, setDiaryEnabled, getDiaryPrompt, setDiaryPrompt, DEFAULT_DIARY_PROMPT,
} from './chat-diary-data.js';
import { loadChatHistory } from './message-chat-data.js';
import { generateDiaries, getDiaryTokenCounts } from '../ai-integration/chat-diary-summarizer.js';
import { loadContacts } from '../contacts/contact-list-data.js';
import { showConfirmPopup } from '../utils/popup-helper.js';
import { showSuccessToast, showErrorToast } from '../ui-components/toast-notification.js';

let busy = false;
let promptDraft = null; // 页面重开仍保留尚未保存的编辑；刷新宿主前请点击保存。
const views = new WeakMap();

export async function renderChatDiaryPage({ contactId }) {
  const fragment = document.createDocumentFragment();
  const container = document.createElement('div');
  container.className = 'chat-diary-page';
  container.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--phone-bg-main,#f0f0f2);';
  container.dataset.contactId = contactId;
  const contact = (await loadContacts()).find(item => item.id === contactId);
  container.innerHTML = `
    <div class="chat-settings-topbar">
      <button type="button" class="chat-settings-back-btn" data-role="back" aria-label="返回"><i class="fa-solid fa-chevron-left"></i></button>
      <div class="chat-settings-title">${escapeHtml(contact?.name || '聊天')}的日记</div>
    </div>
    <div class="chat-settings-content" style="flex:1;overflow-y:auto;padding:12px;">
      <div data-role="toolbar" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">
        <label><input type="checkbox" data-role="diary-enabled"> 在上下文里用日记替换原始聊天记录</label>
        <details data-role="prompt-editor" style="background:var(--phone-bg-card,#fff);border-radius:8px;padding:10px;">
          <summary>总结提示词（点击编辑）</summary>
          <p style="font-size:12px;opacity:.8;">可自行修改写法、篇幅、是否引用原话。保存后全手机共用；JSON 分日保存协议由插件追加，无需在这里写。只改变今后生成的日记。</p>
          <textarea data-role="prompt" aria-label="总结提示词" rows="12" style="width:100%;box-sizing:border-box;resize:vertical;min-height:180px;"></textarea>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" data-role="save-prompt">保存提示词</button>
            <button type="button" data-role="reset-prompt">恢复默认到编辑框</button>
          </div>
          <div data-role="prompt-status" style="font-size:12px;opacity:.8;"></div>
        </details>
        <div style="font-size:12px;line-height:1.6;opacity:.8;">选日期决定写哪几天，不限制背景：每次生成仍带角色资料和该联系人的全部未排除原始历史，且只发送一次模型生成请求。每天 ≤${DIARY_SKIP_THRESHOLD} 条跳过。</div>
        <div style="font-size:12px;line-height:1.6;opacity:.8;">日期后的 token 是当天原始聊天文本估算，不含角色卡、总结提示词、请求包装或图片视觉 token，不等于实际计费。统计会调用宿主分词接口，不生成回复。</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" data-role="generate-selected">总结勾选日期</button>
          <button type="button" data-role="select-pending">勾选全部待总结</button>
          <button type="button" data-role="clear-selection">清空勾选</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" data-role="generate-missing">一键总结全部待总结</button>
          <button type="button" data-role="generate-all">全部重写</button>
          <button type="button" data-role="refresh">刷新日期与 token</button>
        </div>
        <div data-role="diary-status" role="status" aria-live="polite" style="font-size:12px;opacity:.8;white-space:pre-wrap;">正在读取日期…</div>
      </div>
      <div data-role="diary-days" style="font-size:13px;line-height:1.7;"></div>
      <div data-role="diary-list" style="margin-top:16px;"></div>
    </div>`;
  const find = role => container.querySelector(`[data-role="${role}"]`);
  const ui = {
    container, contactId, find,
    prompt: find('prompt'), enabled: find('diary-enabled'), days: find('diary-days'), list: find('diary-list'),
    selected: new Set(), statuses: [], entries: [], tokens: new Map(), tokenNodes: new Map(),
    tokenRun: 0, loading: true, ready: false,
  };
  views.set(container, ui);
  ui.prompt.value = promptDraft ?? getDiaryPrompt();
  ui.enabled.checked = isDiaryEnabled();
  ui.prompt.addEventListener('input', () => {
    promptDraft = ui.prompt.value;
    syncControls(ui);
  });
  find('save-prompt').addEventListener('click', () => void runAction(ui, async () => {
    await savePrompt(ui);
    setStatus(ui, '总结提示词已保存；下次生成会使用它。');
  }));
  find('reset-prompt').addEventListener('click', () => {
    if (busy || ui.loading) return;
    ui.prompt.value = DEFAULT_DIARY_PROMPT;
    promptDraft = ui.prompt.value;
    find('prompt-editor').open = true;
    syncControls(ui);
  });
  find('back').addEventListener('click', () => void runAction(ui, async () => {
    const { hidePage } = await import('../phone-main-ui.js');
    hidePage(document.querySelector('.phone-overlay'), 'chat-diary');
  }));
  ui.enabled.addEventListener('change', () => {
    const enabled = ui.enabled.checked;
    void runAction(ui, async () => {
      await setDiaryEnabled(enabled);
      setStatus(ui, enabled ? '已启用日记替换。' : '已关闭日记替换，继续使用原始历史。');
    });
  });
  find('select-pending').addEventListener('click', () => {
    if (busy || ui.loading) return;
    ui.selected = new Set(ui.statuses.filter(day => day.status === 'pending').map(day => day.date));
    renderDays(ui);
    syncControls(ui);
  });
  find('clear-selection').addEventListener('click', () => {
    if (busy || ui.loading) return;
    ui.selected.clear();
    renderDays(ui);
    syncControls(ui);
  });
  find('generate-selected').addEventListener('click', () => {
    const dates = [...ui.selected].sort();
    if (dates.length) void runGenerate(ui, { dates, regenerate: true });
  });
  find('generate-missing').addEventListener('click', () => void runGenerate(ui, { dates: null, regenerate: false }));
  find('generate-all').addEventListener('click', () => void runGenerate(ui, { dates: null, regenerate: true }));
  find('refresh').addEventListener('click', () => void runAction(ui, async () => {
    setStatus(ui, '已刷新日期，正在更新 token 估算。');
  }, { refresh: true }));
  try {
    await refreshView(ui);
    setStatus(ui, '可勾选多个日期，或点击某天的“总结”；编辑提示词后请保存。');
  } catch (error) { reportError(ui, error); }
  fragment.appendChild(container);
  return fragment;
}

function setStatus(ui, text) { ui.find('diary-status').textContent = text; }

function syncControls(current) {
  const containers = new Set(document.querySelectorAll('.chat-diary-page'));
  containers.add(current.container);
  for (const container of containers) {
    const ui = views.get(container);
    if (!ui) continue;
    const eligible = ui.statuses.filter(day => day.status !== 'skipped');
    const pending = eligible.filter(day => day.status === 'pending');
    ui.find('generate-selected').textContent = `总结勾选日期（${ui.selected.size} 天 / 一次请求）`;
    ui.find('generate-selected').dataset.unavailable = String(!ui.ready || ui.selected.size === 0);
    ui.find('clear-selection').dataset.unavailable = String(ui.selected.size === 0);
    ui.find('select-pending').dataset.unavailable = String(!ui.ready || !pending.length);
    ui.find('generate-missing').dataset.unavailable = String(!ui.ready || !pending.length);
    ui.find('generate-all').dataset.unavailable = String(!ui.ready || !eligible.length);
    const dirty = ui.prompt.value !== getDiaryPrompt();
    ui.find('prompt-status').textContent = dirty ? '有未保存的修改；生成前会询问是否保存。' : '已保存（全手机共用）';
    ui.find('save-prompt').dataset.unavailable = String(!dirty || !ui.prompt.value.trim());
    for (const control of container.querySelectorAll('button, input, textarea')) {
      control.disabled = busy || ui.loading || control.dataset.unavailable === 'true';
    }
  }
}

function reportError(ui, error) {
  logger.warn('phone', '[ChatDiary] 操作未完成:', error?.message || '未知错误');
  setStatus(ui, `操作未完成：${error?.message || '未知错误'}`);
  showErrorToast(error?.message || '日记操作失败');
}

async function runAction(ui, action, { refresh = false } = {}) {
  if (busy || ui.loading) return;
  busy = true;
  syncControls(ui);
  try { await action(); }
  catch (error) { reportError(ui, error); }
  finally {
    try {
      if (refresh) await refreshView(ui);
    } catch (error) { reportError(ui, error); }
    finally {
      ui.enabled.checked = isDiaryEnabled();
      busy = false;
      syncControls(ui);
    }
  }
}

async function savePrompt(ui) {
  const text = ui.prompt.value;
  await setDiaryPrompt(text);
  promptDraft = null;
  syncControls(ui);
  showSuccessToast('总结提示词已保存');
}

async function ensureSavedPrompt(ui) {
  if (ui.prompt.value === getDiaryPrompt()) return true;
  const confirmed = await showConfirmPopup('提示词尚未保存', '先保存编辑框内的提示词，再按它生成日记？取消不会调用模型。', { okButton: '保存并继续' });
  if (!confirmed) return false;
  await savePrompt(ui);
  return true;
}

async function runGenerate(ui, options) {
  if (!ui.ready) return;
  await runAction(ui, async () => {
    const targets = ui.statuses.filter(day => day.status !== 'skipped' &&
      (!Array.isArray(options.dates) || options.dates.includes(day.date)) &&
      (options.regenerate || day.status === 'pending'));
    if (!targets.length) { setStatus(ui, '没有符合条件的日期，不发送请求。'); return; }
    const existingDates = new Set(ui.entries.map(entry => entry.date));
    const overwritten = targets.filter(day => existingDates.has(day.date));
    if (overwritten.length) {
      const confirmed = await showConfirmPopup('覆盖已有日记', `本次会覆盖 ${overwritten.map(day => day.date).join('、')} 的日记；原始聊天保留。所有目标日期共用一次生成请求，继续？`, { okButton: '继续' });
      if (!confirmed) return;
    }
    if (!await ensureSavedPrompt(ui)) return;
    setStatus(ui, '正在准备完整历史…');
    const result = await generateDiaries(ui.contactId, {
      ...options,
      onProgress: info => {
        const label = { preparing: '准备完整历史', requesting: '已提交一次生成请求，等待日记', saving: '正在保存日记' }[info.stage] || '正在整理';
        setStatus(ui, `${label}（${info.total} 天）\n${(info.dates || []).join('、')}`);
      },
    });
    for (const date of result.updated) ui.selected.delete(date);
    const lines = [];
    if (result.updated.length) { lines.push(`已生成：${result.updated.join('、')}`); showSuccessToast(`已生成 ${result.updated.length} 天日记`); }
    if (result.skipped.length) lines.push(`≤${DIARY_SKIP_THRESHOLD} 条，跳过：${result.skipped.join('、')}`);
    if (result.failed.length) { lines.push(`未保存：${result.failed.map(item => item.date).join('、')}\n${result.failed[0].error}`); showErrorToast('日记生成或保存未完成'); }
    setStatus(ui, lines.join('\n') || '没有需要生成的日期。');
  }, { refresh: true });
}

async function refreshView(ui) {
  ui.loading = true;
  ui.ready = false;
  const run = ++ui.tokenRun;
  syncControls(ui);
  try {
    const messages = await loadChatHistory(ui.contactId);
    ui.entries = loadDiaryEntries(ui.contactId);
    ui.statuses = getDiaryDayStatuses(messages, ui.entries);
    const eligible = new Set(ui.statuses.filter(day => day.status !== 'skipped').map(day => day.date));
    ui.selected = new Set([...ui.selected].filter(date => eligible.has(date)));
    ui.tokens.clear();
    renderDays(ui);
    renderEntries(ui);
    ui.ready = true;
    // 后台仅统计 token；不锁住日期选择，也不会触发模型生成。
    void getDiaryTokenCounts(ui.contactId, {
      onUpdate: (date, count) => {
        if (run !== ui.tokenRun) return;
        ui.tokens.set(date, count);
        const node = ui.tokenNodes.get(date);
        if (node) node.textContent = formatTokens(count);
      },
    }).catch(() => {
      if (run !== ui.tokenRun) return;
      for (const [date, node] of ui.tokenNodes) if (!ui.tokens.has(date)) node.textContent = 'token 统计暂不可用';
    });
  } finally {
    ui.loading = false;
    syncControls(ui);
  }
}

function formatTokens(count) {
  if (!count || !Number.isFinite(count.count)) return 'token 计算中…';
  return `${count.estimated ? '约 ' : ''}${count.count.toLocaleString()} tokens${count.source === 'heuristic' ? '（粗估）' : ''}`;
}

function renderDays(ui) {
  ui.days.replaceChildren();
  ui.tokenNodes.clear();
  const heading = document.createElement('strong');
  const pending = ui.statuses.filter(day => day.status === 'pending').length;
  heading.textContent = `按日期选择 · ${pending} 天待总结`;
  ui.days.appendChild(heading);
  const existing = new Set(ui.entries.map(entry => entry.date));
  for (const day of ui.statuses) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--phone-bg-card,#fff);border-radius:8px;padding:8px;margin-top:6px;';
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;min-width:170px;';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = ui.selected.has(day.date);
    checkbox.dataset.unavailable = String(day.status === 'skipped');
    checkbox.setAttribute('aria-label', `选择 ${day.date}`);
    checkbox.addEventListener('change', () => {
      if (busy || ui.loading) return;
      if (checkbox.checked) ui.selected.add(day.date); else ui.selected.delete(day.date);
      syncControls(ui);
    });
    label.appendChild(checkbox);
    const text = document.createElement('span');
    const state = { pending: '待总结', summarized: '已总结', skipped: `≤${DIARY_SKIP_THRESHOLD} 条，跳过` }[day.status];
    text.textContent = `${day.date} · ${day.messageCount} 条 · ${state}`;
    label.appendChild(text);
    row.appendChild(label);
    const tokens = document.createElement('span');
    tokens.style.cssText = 'font-size:12px;opacity:.8;';
    tokens.textContent = formatTokens(ui.tokens.get(day.date));
    ui.tokenNodes.set(day.date, tokens);
    row.appendChild(tokens);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = existing.has(day.date) ? '重写当天' : '总结当天';
    button.dataset.unavailable = String(day.status === 'skipped');
    button.addEventListener('click', () => void runGenerate(ui, { dates: [day.date], regenerate: true }));
    row.appendChild(button);
    ui.days.appendChild(row);
  }
  if (!ui.statuses.length) ui.days.appendChild(document.createTextNode(' 没有可显示日期的聊天记录。'));
}

function renderEntries(ui) {
  ui.list.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = `已有日记（${ui.entries.length} 天）`;
  ui.list.appendChild(heading);
  for (const entry of [...ui.entries].reverse()) {
    const item = document.createElement('details');
    item.style.cssText = 'background:var(--phone-bg-card,#fff);border-radius:8px;padding:10px;margin-top:8px;';
    const summary = document.createElement('summary');
    summary.textContent = entry.date;
    item.appendChild(summary);
    const body = document.createElement('div');
    body.style.cssText = 'white-space:pre-wrap;line-height:1.6;font-size:13px;margin:8px 0;';
    body.textContent = entry.content;
    item.appendChild(body);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '删除这篇日记（保留原聊天）';
    button.addEventListener('click', () => void runAction(ui, async () => {
      const confirmed = await showConfirmPopup('删除日记', `删除 ${entry.date} 的日记？不会删除原始聊天。`, { okButton: '删除', danger: true });
      if (!confirmed) return;
      await removeDiaryEntry(ui.contactId, entry.date);
      setStatus(ui, `${entry.date} 的日记已删除，原始聊天保留。`);
    }, { refresh: true }));
    item.appendChild(button);
    ui.list.appendChild(item);
  }
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
