/** 手动补录一条角色最终回复；只调用预览/持久化接口，不调用模型。 */
import { previewManualReply, commitManualReply } from './manual-reply-data.js';
import { loadContacts } from '../contacts/contact-list-data.js';
import { getContactDisplayName } from '../utils/contact-display-helper.js';

// 写入结果不明时，离开再打开页面也不能绕过保护；刷新后由后端查重。
const faultedContacts = new Set();

/** 兼容已有独立路由；自带顶部栏，由路由提供外层 phone-page。 */
export async function renderManualReplyPage(params) {
  const { fragment } = await renderManualReplyCore(params, true);
  return fragment;
}

/**
 * 嵌入 AI 消息调试；不创建独立页面，也不自动预览或保存。
 * 状态回调在初次同步及 busy/faulted/saved 变化时触发，不包含正文。
 */
export async function renderManualReplyPanel({ contactId, initialText = '', initialTime, onStateChange }) {
  return renderManualReplyCore({ contactId, initialText, initialTime, onStateChange });
}

async function renderManualReplyCore({ contactId, initialText = '', initialTime, onStateChange }, standalone = false) {
  const fragment = document.createDocumentFragment();
  const page = element('div', standalone ?
    'chat-settings-page manual-reply-ui manual-reply-page' : 'manual-reply-ui manual-reply-panel');
  const style = element('style');
  style.textContent = `
    .manual-reply-ui { color:var(--phone-text-primary); min-height:0; }
    .manual-reply-panel { display:flex; flex-direction:column; flex:1 1 auto; height:100%; min-width:0; overflow:hidden; }
    .manual-reply-ui .manual-reply-content { padding:12px; min-height:0; }
    .manual-reply-panel .manual-reply-content { flex:1 1 0; overflow-y:auto; overscroll-behavior:contain; }
    .manual-reply-ui .manual-reply-card { padding:12px; margin:0 0 12px; border:1px solid var(--phone-border); border-radius:8px; background:var(--phone-bg-card,var(--phone-bg-white)); }
    .manual-reply-ui .manual-reply-note { margin:8px 0; font-size:12px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--phone-text-secondary); }
    .manual-reply-ui .manual-reply-heading { margin:0 0 10px; font-size:15px; }
    .manual-reply-ui textarea, .manual-reply-ui input[type="datetime-local"] { display:block; width:100%; box-sizing:border-box; padding:10px; margin:8px 0 12px; border:1px solid var(--phone-border); border-radius:6px; background:var(--phone-field-bg,var(--phone-bg-white)); color:var(--phone-field-text,var(--phone-text-primary)); font:inherit; }
    .manual-reply-ui textarea { min-height:180px; resize:vertical; line-height:1.6; }
    .manual-reply-ui .manual-reply-check { display:flex; align-items:flex-start; gap:8px; line-height:1.7; font-size:13px; }
    .manual-reply-ui input[type="checkbox"] { accent-color:var(--phone-primary); flex-shrink:0; margin-top:5px; }
    .manual-reply-ui .manual-reply-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .manual-reply-ui .manual-reply-button { padding:8px 12px; border:1px solid var(--phone-border); border-radius:6px; background:var(--phone-bg-main); color:var(--phone-text-primary); font:inherit; cursor:pointer; }
    .manual-reply-ui .manual-reply-body { margin:10px 0; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.7; }
    .manual-reply-ui .manual-reply-error { color:var(--phone-danger,var(--phone-text-primary)); }
    .manual-reply-ui button:disabled, .manual-reply-ui input:disabled { opacity:.55; cursor:default; }
    .manual-reply-ui :is(button,textarea,input):focus-visible { outline:2px solid var(--phone-primary); outline-offset:3px; }
    .manual-reply-ui [hidden] { display:none !important; }
  `;
  page.appendChild(style);
  let back = null;
  if (standalone) {
    const topbar = element('div', 'chat-settings-topbar');
    back = button('‹', 'chat-settings-back-btn');
    back.setAttribute('aria-label', '返回聊天设置');
    topbar.append(back, element('div', 'chat-settings-title', '补录角色回复'));
    page.appendChild(topbar);
  }
  const content = element('div', standalone ?
    'chat-settings-content manual-reply-content' : 'manual-reply-content');
  content.appendChild(element('p', 'manual-reply-note',
    '只粘贴日志中的角色最终回复，不要粘贴整份 API 请求、日志、密钥或凭据。此功能不调用 AI，不重新生成。\n只补录为一条纯文本聊天气泡，不执行钱包、好友、计划等操作；sidecar／小剧场与 think 思考块会隔离，不导入聊天。'));

  let targetName = String(contactId || '未指定联系人');
  try {
    const contacts = await loadContacts();
    const contact = contacts.find(item => item.id === contactId);
    if (contact) targetName = String(getContactDisplayName(contact));
  } catch {
    // 显示目标 ID；联系人有效性仍由后端预览严格检查。
  }
  const form = element('section', 'manual-reply-card');
  form.appendChild(element('h2', 'manual-reply-heading', `补录到：${targetName}`));
  const sourceLabel = element('label', '', '角色最终回复（纯文本）');
  const source = element('textarea');
  source.rows = 9;
  source.spellcheck = false;
  source.autocomplete = 'off';
  source.value = String(initialText ?? '');
  source.setAttribute('aria-label', '粘贴角色最终回复纯文本');
  sourceLabel.appendChild(source);
  const timeLabel = element('label', '', '消息时间（当前设备本地时间）');
  const time = element('input');
  time.type = 'datetime-local';
  time.step = '1';
  time.required = true;
  time.value = localDateTimeFromSeconds(initialTime) || localDateTimeNow();
  timeLabel.appendChild(time);
  const proactiveLabel = element('label', 'manual-reply-check');
  const proactive = element('input');
  proactive.type = 'checkbox';
  proactive.checked = true;
  proactiveLabel.append(proactive, element('span', '', '这条是主动唤醒的回复（计入当天额度并等待用户回复）'));
  const actions = element('div', 'manual-reply-actions');
  const previewButton = button('预览补录');
  const saveButton = button('确认并保存');
  actions.append(previewButton, saveButton);
  form.append(sourceLabel, timeLabel, proactiveLabel, actions);
  const previewSection = element('section', 'manual-reply-card');
  previewSection.hidden = true;
  previewSection.appendChild(element('h2', 'manual-reply-heading', '将保存的纯文本气泡'));
  const previewMeta = element('p', 'manual-reply-note');
  const previewBody = element('div', 'manual-reply-body');
  const warnings = element('div', 'manual-reply-note');
  const duplicateNote = element('p', 'manual-reply-note manual-reply-error');
  const duplicateLabel = element('label', 'manual-reply-check');
  const allowDuplicate = element('input');
  allowDuplicate.type = 'checkbox';
  allowDuplicate.checked = false;
  duplicateLabel.append(allowDuplicate, element('span', '', '确认是另一条不同的回复，仍需补录'));
  previewSection.append(previewMeta, previewBody, warnings, duplicateNote, duplicateLabel);
  const status = element('p', 'manual-reply-note');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const confirmation = element('section', 'manual-reply-card');
  confirmation.hidden = true;
  content.append(form, previewSection, confirmation, status);
  page.appendChild(content);
  fragment.appendChild(page);

  let busy = false;
  let faulted = faultedContacts.has(contactId);
  let saved = false;
  let revision = 0;
  let preview = null;
  let previewInput = null;
  let lastState = null;

  function setStatus(text, error = false) {
    status.textContent = text;
    status.classList.toggle('manual-reply-error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  }

  function currentInput() {
    return { raw: source.value, localTime: time.value, proactive: proactive.checked };
  }

  function previewIsCurrent() {
    const input = currentInput();
    return preview && previewInput && input.raw === previewInput.raw &&
      input.localTime === previewInput.localTime && input.proactive === previewInput.proactive;
  }

  function syncControls() {
    page.setAttribute('aria-busy', String(busy));
    if (back) back.disabled = busy;
    // 即使发生写入故障也保持原文可选择、复制，不能 disabled。
    source.readOnly = busy || faulted || saved;
    time.disabled = busy || faulted || saved;
    proactive.disabled = busy || faulted || saved;
    allowDuplicate.disabled = busy || faulted || saved;
    previewButton.disabled = busy || faulted || saved || !source.value.trim() || !time.value;
    saveButton.disabled = busy || faulted || saved || !previewIsCurrent() ||
      Boolean(preview?.duplicate && !allowDuplicate.checked);
    if (!lastState || lastState.busy !== busy || lastState.faulted !== faulted || lastState.saved !== saved) {
      lastState = { busy, faulted, saved };
      // 宿主观察器不能打断控件锁定、确认或结果不明保护；不向外传正文。
      if (typeof onStateChange === 'function') {
        try { onStateChange({ ...lastState }); } catch { /* 初次渲染时宿主可能尚未取得面板。 */ }
      }
    }
  }

  function invalidatePreview() {
    revision += 1;
    preview = null;
    previewInput = null;
    allowDuplicate.checked = false;
    previewSection.hidden = true;
    previewBody.textContent = '';
    warnings.textContent = '';
    if (!faulted && !saved) setStatus('内容或选项已更改，请重新预览。');
    syncControls();
  }

  function setSourceText(text, { time: seconds, replace = false } = {}) {
    if (busy || faulted || saved || typeof text !== 'string') return false;
    if (replace !== true && source.value.length > 0 && source.value !== text) return false;
    source.value = text;
    const localTime = localDateTimeFromSeconds(seconds);
    if (localTime) time.value = localTime;
    invalidatePreview();
    return true;
  }

  for (const control of [source, time, proactive]) {
    control.addEventListener('input', invalidatePreview);
    control.addEventListener('change', invalidatePreview);
  }
  allowDuplicate.addEventListener('change', syncControls);

  back?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    syncControls();
    try {
      const overlay = document.querySelector('.phone-overlay');
      if (!overlay) throw new Error('missing overlay');
      const { hidePage } = await import('../phone-main-ui.js');
      await hidePage(overlay, 'manual-reply');
    } catch {
      if (!faulted) setStatus('暂时无法返回，请重试。', true);
    } finally {
      busy = false;
      syncControls();
    }
  });

  previewButton.addEventListener('click', async () => {
    if (busy || faulted || saved) return;
    invalidatePreview();
    const input = currentInput();
    const milliseconds = new Date(input.localTime).getTime();
    if (!time.checkValidity() || !Number.isFinite(milliseconds)) {
      setStatus('请填写有效的本地消息时间。', true);
      return;
    }
    const requestedRevision = revision;
    busy = true;
    syncControls();
    setStatus('正在检查并预览；尚未保存。');
    try {
      const result = await previewManualReply(contactId, input.raw, {
        time: Math.floor(milliseconds / 1000), proactive: input.proactive,
      });
      if (requestedRevision !== revision) return;
      // 保留后端返回的同一个不可变预览对象，保存时不重建/改写。
      preview = result;
      previewInput = input;
      previewMeta.textContent = `时间：${formatTime(result.time)}；${result.proactive ? '主动唤醒回复' : '普通回复'}`;
      previewBody.textContent = result.text;
      warnings.replaceChildren(...result.warnings.map(text => element('p', '', text)));
      duplicateNote.textContent = result.duplicate ?
        `发现相同正文的已有回复（${formatTime(result.duplicate.time)}）。默认不重复补录；仅确认确实是另一条回复时勾选下方选项。` : '';
      duplicateLabel.hidden = !result.duplicate;
      allowDuplicate.checked = false;
      previewSection.hidden = false;
      setStatus('预览完成，尚未保存。请核对正文、目标和时间。');
    } catch (error) {
      if (requestedRevision === revision) {
        preview = null;
        previewInput = null;
        const reason = displayReason(error);
        setStatus(reason
          ? `无法预览：${reason}`
          : '无法预览：请检查联系人、消息时间及最终回复正文。不要粘贴整份请求、日志或凭据；原文仍可编辑。', true);
      }
    } finally {
      busy = false;
      syncControls();
    }
  });

  // 异步确认只用 textContent，不能把目标/正文传给 innerHTML 弹窗工具。
  function confirmSave(candidate, duplicateAllowed) {
    return new Promise(resolve => {
      confirmation.replaceChildren();
      confirmation.setAttribute('role', 'dialog');
      confirmation.setAttribute('aria-label', '确认补录角色回复');
      confirmation.appendChild(element('h2', 'manual-reply-heading', '确认补录角色回复'));
      const summary = Array.from(candidate.text.replace(/\s+/g, ' ').trim());
      const shortBody = summary.slice(0, 60).join('') + (summary.length > 60 ? '…' : '');
      confirmation.appendChild(element('p', 'manual-reply-note',
        `目标：${Array.from(targetName).slice(0, 80).join('')}\n时间：${formatTime(candidate.time)}\n正文摘要：${shortBody}\n仅保存一条纯文本气泡，不调用 AI。${duplicateAllowed ? '\n已明确允许补录另一条同文回复。' : ''}`));
      const row = element('div', 'manual-reply-actions');
      const cancel = button('取消');
      const confirm = button('保存这条回复');
      row.append(cancel, confirm);
      confirmation.appendChild(row);
      confirmation.hidden = false;
      let settled = false;
      const onKey = event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          finish(false);
        }
      };
      const finish = result => {
        if (settled) return;
        settled = true;
        confirmation.removeEventListener('keydown', onKey);
        confirmation.hidden = true;
        confirmation.replaceChildren();
        resolve(result);
      };
      cancel.addEventListener('click', () => finish(false), { once: true });
      confirm.addEventListener('click', () => finish(true), { once: true });
      confirmation.addEventListener('keydown', onKey);
      cancel.focus();
    });
  }

  saveButton.addEventListener('click', async () => {
    if (busy || faulted || saved || !previewIsCurrent()) return;
    const candidate = preview;
    const duplicateAllowed = candidate.duplicate !== null && allowDuplicate.checked;
    if (candidate.duplicate && !duplicateAllowed) return;
    // 必须在等待用户确认前锁定，防止双击创建两个确认/写入任务。
    busy = true;
    syncControls();
    try {
      const confirmed = await confirmSave(candidate, duplicateAllowed);
      if (!confirmed) {
        setStatus('已取消，未保存。');
        return;
      }
      if (candidate !== preview || !previewIsCurrent()) {
        setStatus('预览已失效，请重新预览。', true);
        return;
      }
      try {
        const result = await commitManualReply(candidate, { allowDuplicate: duplicateAllowed });
        saved = true;
        preview = null;
        previewInput = null;
        const savedText = result.alreadyExists ? '已存在：未新增回复（0 条）。' : '已保存 1 条回复。';
        setStatus(savedText + (result.displayPending ? '当前缓存未更新，请关闭手机再打开；较早的日期需上滑查看。' : '可返回聊天；较早的日期需上滑查看。'));
      } catch (error) {
        preview = null;
        previewInput = null;
        const reason = displayReason(error);
        if (error?.manualReplyPreflight) {
          // Deterministic failure before any write: allow the user to preview
          // again instead of permanently locking this contact.
          setStatus(`未保存${reason ? `：${reason}` : '；请重新预览'}`, true);
        } else {
          faulted = true;
          faultedContacts.add(contactId);
          setStatus(`保存结果不明${reason ? `：${reason}` : '，结果可能已写入'}。请先导出手机备份再刷新；本页已停止预览和保存，原文仍可复制。`, true);
        }
      }
    } finally {
      busy = false;
      syncControls();
    }
  });

  if (faulted) setStatus('此前保存结果不明，结果可能已写入，勿重复补录。请先导出手机备份再刷新；本页已停止预览和保存。', true);
  syncControls();
  return {
    fragment,
    setSourceText,
    hasDraft: () => source.value.length > 0,
    isBusy: () => busy,
    isFaulted: () => faulted,
  };
}

function displayReason(error) {
  const code = error?.code;
  if (code === 'NOT_READY') return '手机存储尚未就绪，未写入。';
  if (code === 'IMPORT_BUSY') return '正在导入手机备份，暂时不能保存，未写入。';
  if (code === 'CONFLICT') return '手机文件已被其他页面修改，未写入。';
  if (code === 'READ_FAILED') return '手机文件读取失败，未写入。';
  const message = error?.message;
  if (typeof message !== 'string') return '';
  const trimmed = message.trim().replace(/[\r\n]+/g, ' ');
  // Product errors are concise Chinese sentences. Keep diagnostics local
  // (English parser/runtime errors may contain internals) and never echo raw
  // pasted text back into the page.
  if (!trimmed || trimmed.length > 160 || !/[\u3400-\u9fff]/.test(trimmed)) return '';
  return trimmed;
}

function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function button(text, className = 'manual-reply-button') {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function localDateTimeNow() {
  return localDateTimeFromSeconds(Date.now() / 1000);
}

function localDateTimeFromSeconds(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatTime(seconds) {
  const date = new Date(Number(seconds) * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间无效';
}
