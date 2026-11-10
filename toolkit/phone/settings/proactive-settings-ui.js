/** Settings UI only. Navigation entry, scheduling and actual sends are wired elsewhere. */
import { hidePage } from '../phone-main-ui.js';
import { loadContacts } from '../contacts/contact-list-data.js';
import { getContactDisplayName } from '../utils/contact-display-helper.js';
import { getProactiveSchedulerStatus } from '../ai-integration/proactive-scheduler.js';
import {
  getProactiveSettings,
  saveProactiveSettings,
  validateProactiveSettings,
} from '../ai-integration/proactive-settings.js';

function description(text) {
  const element = document.createElement('p');
  element.className = 'chat-settings-item-desc';
  element.style.cssText = 'margin:0.65em 1em;line-height:1.6;color:var(--phone-text-secondary);overflow-wrap:anywhere;';
  element.textContent = text;
  return element;
}

function sectionTitle(text) {
  const element = document.createElement('h3');
  element.className = 'chat-settings-section-title';
  element.style.cssText = 'margin:1em;font-size:0.95em;color:var(--phone-text-primary);';
  element.textContent = text;
  return element;
}

function checkboxRow(text, checked) {
  const row = document.createElement('label');
  row.className = 'chat-settings-item';
  row.style.gap = '0.75em';
  const label = document.createElement('span');
  label.className = 'chat-settings-item-label';
  label.style.overflowWrap = 'anywhere';
  label.textContent = text;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.style.cssText = 'flex-shrink:0;accent-color:var(--phone-primary);';
  row.append(label, input);
  return { row, input };
}

function numberRow(text, value, min, max, step = '1') {
  const row = document.createElement('label');
  row.className = 'chat-settings-item chat-settings-item-number';
  row.style.gap = '0.75em';
  const label = document.createElement('span');
  label.className = 'chat-settings-item-label';
  label.textContent = text;
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'chat-settings-number-input';
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  input.step = step;
  input.required = true;
  input.style.cssText = 'width:6em;max-width:45%;color:var(--phone-text-primary);background:var(--phone-bg-main);border:1px solid var(--phone-border);border-radius:0.35em;padding:0.4em;';
  row.append(label, input);
  return { row, input };
}

function parseIdleMinutes(input) {
  const hours = input.value.trim() === '' ? NaN : Number(input.value);
  const minutes = hours * 60;
  const rounded = Math.round(minutes);
  if (!Number.isFinite(minutes) || Math.abs(minutes - rounded) > 1e-7 || rounded < 15 || rounded > 10080) {
    throw new RangeError('沉默时长请输入 0.25–168 小时，并精确到整分钟（默认 2 小时）。');
  }
  return rounded;
}

function parseDailyLimit(input) {
  const value = input.value.trim() === '' ? NaN : Number(input.value);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new RangeError('每日实际消息上限请输入 1–50 的整数。');
  }
  return value;
}

function availableContacts(contacts) {
  const unique = new Map();
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    if (contact && typeof contact.id === 'string' && contact.id.trim() && !unique.has(contact.id)) {
      unique.set(contact.id, contact);
    }
  }
  return [...unique.values()];
}

/** @returns {Promise<DocumentFragment>} A self-contained page with its own back bar. */
export async function renderProactiveSettingsPage() {
  const settings = getProactiveSettings();
  const contacts = availableContacts(await loadContacts());
  const fragment = document.createDocumentFragment();
  const container = document.createElement('div');
  container.className = 'chat-settings-page proactive-settings-page';
  container.style.cssText = 'min-height:0;color:var(--phone-text-primary);';

  const topbar = document.createElement('div');
  topbar.className = 'chat-settings-topbar';
  const back = document.createElement('button');
  back.className = 'chat-settings-back-btn';
  back.type = 'button';
  back.setAttribute('aria-label', '返回');
  back.innerHTML = '<i class="fa-solid fa-chevron-left" aria-hidden="true"></i>';
  back.addEventListener('click', () => {
    const overlay = container.closest('.phone-overlay') || document.querySelector('.phone-overlay');
    if (overlay) hidePage(overlay, 'proactive-settings');
  });
  const title = document.createElement('div');
  title.className = 'chat-settings-title';
  title.textContent = '主动消息';
  topbar.append(back, title);

  const content = document.createElement('div');
  content.className = 'chat-settings-content';
  content.style.minHeight = '0';
  const form = document.createElement('form');
  form.className = 'chat-settings-list';
  form.noValidate = true;
  const fields = document.createElement('fieldset');
  fields.style.cssText = 'border:0;padding:0;margin:0;min-width:0;';

  const runtimeState = getProactiveSchedulerStatus();
  if (!runtimeState.supported) {
    fields.appendChild(description('当前浏览器/地址不支持 Web Locks 安全互斥，自动付费请求已暂停。请使用 localhost、HTTPS 或支持此功能的客户端；普通局域网 HTTP 页面可能不支持。设置仍可保存。'));
  } else if (runtimeState.faulted) {
    fields.appendChild(description('主动任务因写入/互斥异常已暂停，请先处理手机存储提示，再重新加载。不会自动强制覆盖或重试。'));
  }
  const diagnostics = document.createElement('details');
  diagnostics.style.cssText = 'margin:0.75em 1em;color:var(--phone-text-secondary);';
  const summary = document.createElement('summary');
  summary.textContent = '运行状态（打开此页时刷新）';
  diagnostics.appendChild(summary);
  diagnostics.appendChild(description(`今日发送额度已用 ${runtimeState.sent} 条（未确认写入也保守计入），模型尝试 ${runtimeState.attempts} 次。最近检查：${runtimeState.lastCheckAt ? new Date(runtimeState.lastCheckAt).toLocaleString() : '尚未检查'}。`));
  const outcomeLabels = {
    sent: '上次已发送（未回复时不会再次主动）',
    'no-send': '上次模型选择不发',
    reserved: '上次请求已预留；若被刷新中断，不会自动重发',
    error: '上次失败或取消，发一条新消息后恢复资格',
    discarded: '上次环境或用户活动已改变，未发送',
    'invalid-response': '上次返回无效，发一条新消息后恢复资格',
  };
  for (const { contactId, outcome } of runtimeState.outcomes) {
    const role = contacts.find(contact => contact.id === contactId);
    if (role && outcomeLabels[outcome]) diagnostics.appendChild(description(`${getContactDisplayName(role)}：${outcomeLabels[outcome]}。`));
  }
  fields.appendChild(diagnostics);

  const master = checkboxRow('启用主动消息（默认关闭）', settings.enabled);
  fields.append(master.row, description('只有你勾选并保存后才会启用；自动调用当前配置的模型 API 可能产生费用。这里不会发起模型测试。'));

  fields.append(sectionTitle('允许主动联系的角色'));
  const roles = document.createElement('div');
  roles.className = 'chat-settings-section-content';
  const roleInputs = [];
  for (const contact of contacts) {
    const control = checkboxRow(getContactDisplayName(contact) || '未命名角色', settings.contactIds.includes(contact.id));
    control.input.value = contact.id;
    roleInputs.push(control.input);
    roles.appendChild(control.row);
  }
  fields.appendChild(roles);
  if (!contacts.length) fields.appendChild(description('暂无可选角色。请先添加联系人，再回来选择；没有角色时无法启用。'));
  fields.appendChild(description('启用时至少选择一个现有角色，最多 100 个。角色发出主动消息后，必须等你回复同一位角色，才可再次主动联系；回复别人不会解除等待。'));

  fields.append(sectionTitle('触发条件（满足任一项）'));
  const idle = checkboxRow('沉默一段时间后允许主动联系', settings.idleEnabled);
  const idleHours = numberRow('沉默时长（小时）', settings.idleMinutes / 60, 0.25, 168, 'any');
  fields.append(idle.row, idleHours.row, description('默认 2 小时；可设为 15 分钟到 7 天（0.25–168 小时），精确到整分钟。关闭沉默触发后，可只使用固定时刻。'));

  const timeRow = document.createElement('label');
  timeRow.className = 'chat-settings-item';
  timeRow.style.cssText = 'display:flex;align-items:stretch;flex-direction:column;gap:0.65em;';
  const timeLabel = document.createElement('span');
  timeLabel.className = 'chat-settings-item-label';
  timeLabel.textContent = '每天固定时刻（可留空）';
  const times = document.createElement('textarea');
  times.rows = 2;
  times.placeholder = '例如 12:00, 22:30';
  times.value = settings.times.join(', ');
  times.spellcheck = false;
  times.setAttribute('aria-label', '每天固定时刻，HH:mm 格式，用逗号或换行分隔');
  times.style.cssText = 'box-sizing:border-box;width:100%;resize:vertical;font:inherit;color:var(--phone-text-primary);background:var(--phone-bg-main);border:1px solid var(--phone-border);border-radius:0.35em;padding:0.5em;';
  timeRow.append(timeLabel, times);
  fields.append(timeRow, description('使用设备本地时间，严格填写 HH:mm，例如 22:30；多个时刻用逗号或换行分隔，重复项合并，最多 12 个。启用时至少保留一种触发条件。'));

  fields.append(sectionTitle('数量与费用保护'));
  const cap = numberRow('每日实际消息上限', settings.dailyLimit, 1, 50);
  fields.append(cap.row, description('这是所有允许角色合计的每日实际消息数，默认 5 条，可改为 1–50 条。每次主动发送只产生一个纯文本气泡，因此上限 5 就是实际最多 5 个气泡；实际消息会照常保存到聊天记录。模型选择静默的 [不发] 不会进入聊天。'));
  const attempts = description('');
  function updateAttemptHint() {
    const dailyLimit = Number(cap.input.value);
    attempts.textContent = Number.isInteger(dailyLimit) && dailyLimit >= 1 && dailyLimit <= 50
      ? `每日自动模型尝试另设上限：max(20, 每日消息上限 × 4)，当前为 ${Math.max(20, dailyLimit * 4)} 次。静默 [不发] 和失败尝试也计入，以避免无限付费调用；此限制不替代实际消息上限。`
      : '每日自动模型尝试另设上限 max(20, 每日消息上限 × 4)；静默 [不发] 和失败也计入，不能替代实际消息上限。';
  }
  cap.input.addEventListener('input', updateAttemptHint);
  updateAttemptHint();
  fields.appendChild(attempts);

  fields.append(sectionTitle('固定运行规则'));
  fields.appendChild(description('每 15 分钟检查一次；设备本地时间 01:00–09:00 固定免打扰，不能关闭。页面关闭、设备离线或休眠时不会运行，也不保证精确到分钟。页面恢复后，只处理最近 15 分钟内到期的固定时刻，不会补发整夜或更早错过的消息。'));

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'chat-settings-item proactive-settings-save-btn';
  submit.style.cssText = 'justify-content:center;width:calc(100% - 2em);font:inherit;color:var(--phone-text-primary);background:var(--phone-bg-white);border:1px solid var(--phone-border);';
  submit.textContent = '保存设置';
  fields.appendChild(submit);

  const status = description('设置仅在点击保存并确认成功后生效。');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  let busy = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    fields.disabled = true;
    back.disabled = true;
    submit.textContent = '正在保存…';
    status.textContent = '正在验证并保存设置…';
    form.setAttribute('aria-busy', 'true');
    try {
      const selectedIds = roleInputs.filter(input => input.checked).map(input => input.value);
      const next = validateProactiveSettings({
        enabled: master.input.checked,
        idleEnabled: idle.input.checked,
        idleMinutes: parseIdleMinutes(idleHours.input),
        times: times.value.split(/[,，\r\n]+/).map(time => time.trim()).filter(Boolean),
        dailyLimit: parseDailyLimit(cap.input),
        contactIds: selectedIds,
      });
      // Recheck the current list, not only the snapshot from when this page opened.
      const existingIds = new Set(availableContacts(await loadContacts()).map(contact => contact.id));
      if (selectedIds.some(id => !existingIds.has(id))) {
        throw new RangeError('选中的角色已不存在，请重新打开此页后选择。');
      }
      const saved = await saveProactiveSettings(next);
      times.value = saved.times.join(', ');
      const capability = getProactiveSchedulerStatus();
      status.textContent = !saved.enabled ? '已确认保存，主动消息保持关闭。'
        : !capability.supported ? '已保存，但当前页面不支持安全互斥，自动请求仍暂停。'
        : capability.faulted ? '设置已保存；请先处理存储提示并重新加载，恢复自动检查。'
        : '已确认保存，主动消息已启用。';
    } catch (error) {
      status.textContent = error instanceof TypeError || error instanceof RangeError
        ? error.message
        : '保存未确认，请查看手机存储状态。若提示冲突或写入结果不明，请重新加载后核对，勿反复重试。';
    } finally {
      busy = false;
      fields.disabled = false;
      back.disabled = false;
      submit.textContent = '保存设置';
      form.removeAttribute('aria-busy');
    }
  });

  form.append(fields, status);
  content.appendChild(form);
  container.append(topbar, content);
  fragment.appendChild(container);
  return fragment;
}
