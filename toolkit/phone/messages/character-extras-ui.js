/** 角色小剧场：只管理独立彩蛋与写作设置，不触发模型请求。 */
import {
  DEFAULT_CHARACTER_EXTRAS_PROMPT,
  getCharacterExtrasSettings,
  saveCharacterExtrasSettings,
  listCharacterExtras,
  removeCharacterExtras,
} from './character-extras-data.js';
import { showConfirmPopup } from '../utils/popup-helper.js';

/** @returns {Promise<DocumentFragment>} 自带顶部栏的页面内容，由路由创建外层 phone-page。 */
export async function renderCharacterExtrasPage({ contactId }) {
  const fragment = document.createDocumentFragment();
  const page = element('div', 'chat-settings-page character-extras-page');
  page.dataset.contactId = contactId;
  const style = element('style');
  style.textContent = `
    .character-extras-page { color:var(--phone-text-primary); min-height:0; }
    .character-extras-page .character-extras-content { padding:12px; min-height:0; }
    .character-extras-page .character-extras-card { background:var(--phone-bg-card,var(--phone-bg-white)); border:1px solid var(--phone-border); border-radius:8px; padding:12px; margin:0 0 12px; }
    .character-extras-page .character-extras-note { font-size:12px; line-height:1.7; color:var(--phone-text-secondary); white-space:pre-wrap; overflow-wrap:anywhere; }
    .character-extras-page .character-extras-heading { font-size:15px; margin:0 0 10px; }
    .character-extras-page .character-extras-toggle { display:flex; align-items:center; gap:8px; cursor:pointer; }
    .character-extras-page input { accent-color:var(--phone-primary); }
    .character-extras-page textarea { display:block; width:100%; box-sizing:border-box; resize:vertical; min-height:180px; margin:10px 0; padding:10px; border:1px solid var(--phone-border); border-radius:6px; background:var(--phone-field-bg,var(--phone-bg-white)); color:var(--phone-field-text,var(--phone-text-primary)); font:inherit; line-height:1.6; }
    .character-extras-page .character-extras-actions { display:flex; flex-wrap:wrap; gap:8px; }
    .character-extras-page .character-extras-button { padding:8px 12px; border:1px solid var(--phone-border); border-radius:6px; background:var(--phone-bg-main); color:var(--phone-text-primary); font:inherit; cursor:pointer; }
    .character-extras-page button:disabled, .character-extras-page textarea:disabled, .character-extras-page input:disabled { opacity:.55; cursor:default; }
    .character-extras-page summary { cursor:pointer; line-height:1.7; overflow-wrap:anywhere; }
    .character-extras-page .character-extras-section-title { font-size:14px; margin:12px 0 6px; overflow-wrap:anywhere; }
    .character-extras-page .character-extras-section-content { margin:0 0 12px; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.7; }
    .character-extras-page .character-extras-delete, .character-extras-page .character-extras-error { color:var(--phone-danger,var(--phone-text-primary)); }
    .character-extras-page :is(button,textarea,input,summary):focus-visible { outline:2px solid var(--phone-primary); outline-offset:3px; }
  `;
  page.appendChild(style);

  const topbar = element('div', 'chat-settings-topbar');
  const back = element('button', 'chat-settings-back-btn', '‹');
  back.type = 'button';
  back.setAttribute('aria-label', '返回聊天设置');
  topbar.append(back, element('div', 'chat-settings-title', '角色小剧场'));
  page.appendChild(topbar);

  const content = element('div', 'chat-settings-content character-extras-content');
  content.appendChild(element('p', 'character-extras-note',
    '同一次回复的虚构角色心理/彩蛋，不是模型内部推理。\n独立保存，不入聊天记录、下次上下文或日记总结；随完整备份保存。'));

  const settingsCard = element('section', 'character-extras-card');
  settingsCard.setAttribute('aria-label', '全局小剧场设置');
  const toggleLabel = element('label', 'character-extras-toggle');
  const enabled = element('input');
  enabled.type = 'checkbox';
  enabled.checked = false;
  toggleLabel.append(enabled, element('span', '', '启用角色小剧场（全手机共用）'));
  settingsCard.append(toggleLabel, element('p', 'character-extras-note',
    '默认关闭。开启后随今后的聊天回复/主动消息生成，不会额外调用模型；[不发]不产生条目。关闭仍保留已有条目。'));

  const promptLabel = element('label');
  promptLabel.appendChild(element('span', '', '写作提示词（全手机共用）'));
  const prompt = element('textarea');
  prompt.rows = 10;
  prompt.setAttribute('aria-label', '角色小剧场写作提示词');
  promptLabel.appendChild(prompt);
  settingsCard.append(promptLabel, element('p', 'character-extras-note',
    '这里只编辑写作内容与风格；生成与保存协议由程序固定追加，不在此编辑。修改后需保存，只影响今后的生成，不改写已有条目。'));
  const actions = element('div', 'character-extras-actions');
  const save = button('保存提示词');
  const reset = button('恢复默认到编辑框');
  actions.append(save, reset);
  const draftStatus = element('p', 'character-extras-note');
  draftStatus.setAttribute('aria-live', 'polite');
  settingsCard.append(actions, draftStatus);
  content.appendChild(settingsCard);

  const status = element('p', 'character-extras-note');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  content.append(status, element('h2', 'character-extras-heading', '已保存的小剧场'));
  const entries = element('div', 'character-extras-list');
  content.appendChild(entries);
  page.appendChild(content);
  fragment.appendChild(page);

  let busy = false;
  let settingsReady = false;
  let savedSettings = { enabled: false, prompt: DEFAULT_CHARACTER_EXTRAS_PROMPT };

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('character-extras-error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  }

  function syncControls() {
    page.setAttribute('aria-busy', String(busy));
    back.disabled = busy;
    enabled.disabled = busy || !settingsReady;
    prompt.disabled = busy || !settingsReady;
    save.disabled = busy || !settingsReady || !prompt.value.trim() || prompt.value === savedSettings.prompt;
    reset.disabled = busy || !settingsReady;
    for (const control of entries.querySelectorAll('button')) control.disabled = busy;
    draftStatus.textContent = !settingsReady ? '设置尚未加载。' :
      prompt.value === savedSettings.prompt ? '当前写作提示词已保存。' : '有未保存的修改；尚未用于生成。';
  }

  // 在等待确认前即锁定，直到持久化完成/失败或取消后统一解锁。
  async function runAction(action, failureMessage) {
    if (busy) return;
    busy = true;
    syncControls();
    try {
      await action();
    } catch {
      setStatus(failureMessage, true);
    } finally {
      enabled.checked = savedSettings.enabled === true;
      busy = false;
      syncControls();
    }
  }

  async function persistSettings(patch) {
    const latest = await getCharacterExtrasSettings();
    const next = { enabled: latest.enabled === true, prompt: latest.prompt, ...patch };
    await saveCharacterExtrasSettings(next);
    savedSettings = next;
  }

  back.addEventListener('click', () => void runAction(async () => {
    const overlay = document.querySelector('.phone-overlay');
    if (!overlay) throw new Error('页面未找到');
    const { hidePage } = await import('../phone-main-ui.js');
    await hidePage(overlay, 'character-extras');
  }, '暂时无法返回，请重试。'));

  enabled.addEventListener('change', () => {
    const nextEnabled = enabled.checked;
    void runAction(async () => {
      await persistSettings({ enabled: nextEnabled });
      setStatus(nextEnabled ? '已启用；仅对今后的聊天回复生效。' : '已关闭；已有小剧场保留。');
    }, '开关未确认保存；请查看存储提示，结果不明时先备份并刷新。');
  });

  prompt.addEventListener('input', syncControls);
  save.addEventListener('click', () => void runAction(async () => {
    if (!prompt.value.trim()) return;
    await persistSettings({ prompt: prompt.value });
    setStatus('写作提示词已保存，只影响今后的生成。');
  }, '提示词未确认保存，编辑仍在框内；请查看存储提示，结果不明时先备份并刷新。'));

  reset.addEventListener('click', () => void runAction(async () => {
    const confirmed = await showConfirmPopup('恢复默认写作提示词',
      '将用默认写作提示词替换编辑框中的内容。需再点击“保存提示词”才会生效；已有小剧场不受影响。',
      { okButton: '恢复到编辑框' });
    if (!confirmed) return;
    prompt.value = DEFAULT_CHARACTER_EXTRAS_PROMPT;
    setStatus('默认提示词已放入编辑框；点击保存后才用于今后的生成。');
  }, '未能恢复默认提示词，请重试。'));

  function showEmpty() {
    if (!entries.childElementCount) entries.appendChild(element('p', 'character-extras-note',
      '还没有小剧场。启用后，今后正常聊天回复附带的小剧场会独立保存在这里。'));
  }

  function renderEntry(entry) {
    const card = element('details', 'character-extras-card');
    const summary = element('summary');
    const time = element('time', '', formatTime(entry.time));
    const date = new Date(Number(entry.time));
    if (Number.isFinite(date.getTime())) time.dateTime = date.toISOString();
    const sections = Array.isArray(entry.sections) ? entry.sections : [];
    summary.append(time, element('span', '', ` · ${sections.map(section => String(section.title || '未命名片段')).join(' / ') || '小剧场'}`));
    card.appendChild(summary);
    for (const section of sections) {
      card.append(element('h3', 'character-extras-section-title', section.title || '未命名片段'),
        element('p', 'character-extras-section-content', section.content ?? ''));
    }
    const remove = button('删除这条小剧场');
    remove.classList.add('character-extras-delete');
    remove.setAttribute('aria-label', `删除 ${formatTime(entry.time)} 的这条小剧场`);
    remove.addEventListener('click', () => void runAction(async () => {
      const confirmed = await showConfirmPopup('删除这条小剧场',
        '只删除这条独立保存的小剧场，不删除或修改任何聊天记录。此操作不可撤销。',
        { danger: true, okButton: '删除小剧场' });
      if (!confirmed) return;
      const removed = await removeCharacterExtras(contactId, entry.id);
      card.remove();
      showEmpty();
      setStatus(removed ? '已删除这条小剧场；聊天记录未改动。' : '这条小剧场已不存在；聊天记录未改动。');
    }, '小剧场未确认删除；请查看存储提示，结果不明时先备份并刷新。'));
    card.appendChild(remove);
    entries.appendChild(card);
  }

  syncControls();
  try {
    savedSettings = await getCharacterExtrasSettings();
    enabled.checked = savedSettings.enabled === true;
    prompt.value = savedSettings.prompt;
    settingsReady = true;
  } catch {
    setStatus('小剧场设置加载失败，暂不可编辑；请返回后重试。', true);
  } finally {
    syncControls();
  }
  try {
    const savedEntries = await listCharacterExtras(contactId);
    for (const entry of savedEntries) renderEntry(entry);
    showEmpty();
  } catch {
    entries.replaceChildren(element('p', 'character-extras-note character-extras-error',
      '小剧场记录加载失败；请返回后重试。'));
  }
  return fragment;
}

function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function button(text) {
  const node = element('button', 'character-extras-button', text);
  node.type = 'button';
  return node;
}

function formatTime(milliseconds) {
  const date = new Date(Number(milliseconds));
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间未知';
}
