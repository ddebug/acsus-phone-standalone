import { eventSource, event_types } from '/script.js';
import {
  extension_settings,
  initPhoneStorage,
  flushPhoneStorage,
  getStorageStatus,
  exportPhoneBackup,
  importPhoneBackup,
  forceOverwritePhoneStorage,
} from './standalone/phone-settings.js';

const PANEL_ID = 'acsus-phone-standalone-settings';
let panel;
let phone;
let loadingPhone;
let starting;
let busy = false;
let shellError = '';
let needsReload = false;
let originalConflict = false;
let observer;

function phoneData() { return extension_settings.acsusStandalonePhone.phone; }
function originalPhonePresent() { return Boolean(document.getElementById('phone-menu-entry')); }
function ui(role) { return panel?.querySelector(`[data-role="${role}"]`); }

let banner;
let dismissedBannerKey = '';

function errorKeyOf(error) {
  if (!error) return '';
  return typeof error === 'string' ? error : `${error.code || 'ERROR'}:${error.message || String(error)}`;
}

function diagnosticsText() {
  const status = getStorageStatus();
  const error = shellError || status.error;
  return JSON.stringify({
    extension: 'acsus-phone-standalone',
    version: '0.2.3',
    ready: status.ready, dirty: status.dirty, saving: status.saving,
    path: status.path,
    error: error ? errorKeyOf(error) : null,
    shellError: shellError || null,
    originalConflict,
    needsReload,
    origin: location.origin,
    secureContext: window.isSecureContext,
    hasLocks: Boolean(globalThis.navigator?.locks),
    time: new Date().toISOString(),
  }, null, 2);
}

function removeBanner() {
  banner?.remove();
  banner = null;
}

function showSafetyBanner(message, detail, key) {
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'standalone-phone-safety-banner';
    banner.className = 'standalone-phone-safety-banner';
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `
      <div class="spsb-head">
        <strong data-role="banner-title">独立小手机提示</strong>
        <button type="button" class="spsb-close" data-role="banner-close" title="关闭提示" aria-label="关闭提示">×</button>
      </div>
      <p data-role="banner-text"></p>
      <details class="spsb-details"><summary>详情</summary><pre data-role="banner-detail"></pre></details>
      <div class="spsb-actions">
        <button type="button" data-role="banner-copy">复制诊断</button>
        <button type="button" data-role="banner-close-action">关闭</button>
      </div>`;
    banner.querySelector('[data-role="banner-close"]').addEventListener('click', () => { dismissedBannerKey = errorKeyOf(shellError || getStorageStatus().error); removeBanner(); });
    banner.querySelector('[data-role="banner-close-action"]').addEventListener('click', () => { dismissedBannerKey = errorKeyOf(shellError || getStorageStatus().error); removeBanner(); });
    banner.querySelector('[data-role="banner-copy"]').addEventListener('click', () => copyDiagnostics());
    document.body.append(banner);
  }
  banner.dataset.key = key || '';
  banner.querySelector('[data-role="banner-text"]').textContent = message;
  banner.querySelector('[data-role="banner-detail"]').textContent = detail || '没有更多细节。';
}

async function copyDiagnostics() {
  try {
    await navigator.clipboard.writeText(diagnosticsText());
    shellError = '';
    updateStatus();
  } catch {
    window.prompt('复制下面的诊断信息发给作者：', diagnosticsText());
  }
}

function updateStatus() {
  if (!panel) return;
  const status = getStorageStatus();
  const error = shellError || status.error;
  let message = !status.ready ? '尚未载入独立手机数据。' : status.saving ? '正在保存独立手机文件…' : status.dirty ? '有未保存的手机数据，请勿关闭页面。' : '独立文件已就绪。';
  if (error) message = `未完成：${typeof error === 'string' ? error : error.message || '存储错误'}\n请先导出备份，不要反复覆盖或关闭页面。`;
  if (originalConflict) message = '检测到原版小手机入口。请在原插件内关闭“手机”功能，然后刷新；不能只关闭手机窗口。其他原插件功能可以保留。';
  if (needsReload) message = '导入已完成。为重新建立所有页面与运行状态，请刷新后再使用手机。';
  ui('storage-status').textContent = `${message}\n数据位置：${status.path || '/user/files/acsus-phone-standalone.json'}`;
  ui('storage-status').dataset.error = String(Boolean(error || originalConflict));
  ui('enabled').checked = status.ready && phoneData().enabled !== false;
  ui('enabled').disabled = busy || !status.ready || originalConflict || needsReload || Boolean(error);
  ui('open').disabled = busy || !status.ready || phoneData().enabled === false || originalConflict || needsReload || Boolean(error);
  ui('export').disabled = busy || !status.ready;
  ui('import').disabled = busy || !status.ready || needsReload || Boolean(error);
  ui('retry-save').disabled = busy || !status.ready || !status.dirty;
  ui('force-save').disabled = busy || !status.ready;
  ui('retry-load').disabled = busy || status.ready;
  if (status.error) {
    const key = errorKeyOf(status.error);
    if (key !== dismissedBannerKey) {
      showSafetyBanner(
        '独立小手机保存失败或发生冲突。新改动可能尚未写入，请到扩展设置导出备份；若提示写入结果不明确，请保留备份后刷新，不要强制覆盖。',
        key,
        key,
      );
    }
  } else if (originalConflict) {
    const key = 'CONFLICT:original-phone';
    if (key !== dismissedBannerKey) {
      showSafetyBanner('检测到原版小手机入口。请在原插件内关闭“手机”功能，然后刷新页面。其他原插件功能可以保留。', key, key);
    }
  } else {
    dismissedBannerKey = '';
    removeBanner();
  }
}

async function runAction(action) {
  if (busy) return;
  busy = true;
  shellError = '';
  updateStatus();
  try { await action(); }
  catch (error) { shellError = error?.message || '操作失败'; }
  finally { busy = false; updateStatus(); }
}

async function loadPhone() {
  if (needsReload || originalConflict || originalPhonePresent()) throw new Error('请先关闭原版手机并刷新页面。');
  const status = getStorageStatus();
  if (!status.ready || status.error) throw new Error('独立数据尚未安全载入，手机不会启动。');
  if (phone) return phone;
  if (!loadingPhone) {
    loadingPhone = (async () => {
      const module = await import('./toolkit/phone/index.js');
      // Never evaluate or start the phone graph until the file load/exclusion gates pass.
      if (originalPhonePresent() || originalConflict) throw new Error('检测到原版手机，请关闭后刷新。');
      await module.initPhone();
      if (originalPhonePresent() || originalConflict) {
        await module.disablePhone();
        throw new Error('原版手机同时启动，已停止独立版，请关闭原手机版本后刷新。');
      }
      phone = module;
      return module;
    })().catch(error => { loadingPhone = null; throw error; });
  }
  return loadingPhone;
}

function downloadJson(value) {
  const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `acsus-phone-backup-${new Date().toISOString().replaceAll(':', '-')}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function mountPanel() {
  if (panel) return;
  panel = document.createElement('details');
  panel.id = PANEL_ID;
  panel.open = true;
  panel.innerHTML = `
    <summary>独立小手机 · Acsus Phone</summary>
    <p class="standalone-phone-note">仅启用一套小手机：先在原 Acsus-Paws-Puffs 内关闭手机功能并刷新。不会修改原插件或自动迁移旧聊天。</p>
    <div class="standalone-phone-actions">
      <label><input type="checkbox" data-role="enabled">启用独立小手机</label>
      <button type="button" data-role="open">打开手机</button>
      <button type="button" data-role="retry-load">重新载入</button>
      <button type="button" data-role="retry-save">重试保存</button>
      <button type="button" data-role="force-save">以内存为准强制保存</button>
    </div>
    <p data-role="storage-status" role="status" aria-live="polite"></p>
    <div class="standalone-phone-actions">
      <button type="button" data-role="export">导出手机备份</button>
      <label><input type="checkbox" data-role="include-secrets">导出时包含 API 凭据（敏感）</label>
    </div>
    <label>手动导入备份／旧设置文件：<input type="file" accept=".json,application/json" data-role="import"></label>
    <p class="standalone-phone-note">备份即使不含密钥，也包含私人聊天。导入只替换独立版，先备份当前独立文件，不删除原记录；默认不迁移 API 凭据。图片仅保留引用，并非随备份打包。不要在多台设备同时编辑；清理宿主“未使用的用户文件”前必须另存备份。</p>
    <button type="button" data-role="reload">刷新页面</button>
    <button type="button" data-role="copy-diagnostics">复制诊断信息</button>
    <button type="button" data-role="selfcheck">上下文自检</button>
    <pre data-role="selfcheck-output" class="standalone-phone-note"></pre>
  `;
  const target = document.querySelector('#extensions_settings2, #extensions_settings');
  if (!target) panel.classList.add('standalone-phone-floating');
  (target || document.body).append(panel);
  ui('open').addEventListener('click', () => runAction(async () => { await (await loadPhone()).openPhoneUI(); }));
  ui('enabled').addEventListener('change', event => {
    const enabled = event.target.checked;
    void runAction(async () => {
      const module = await loadPhone();
      if (enabled) await module.enablePhone();
      else await module.disablePhone();
      await flushPhoneStorage();
    });
  });
  ui('retry-load').addEventListener('click', () => runAction(initialize));
  ui('retry-save').addEventListener('click', () => runAction(flushPhoneStorage));
  ui('force-save').addEventListener('click', () => runAction(async () => {
    if (!window.confirm('这会用当前页面内存里的手机数据覆盖独立文件（先导出备份！）。确定继续？')) return;
    await forceOverwritePhoneStorage();
  }));
  ui('reload').addEventListener('click', () => location.reload());
  ui('copy-diagnostics').addEventListener('click', () => { void copyDiagnostics(); });
  ui('selfcheck').addEventListener('click', () => runAction(async () => {
    const { getChatSendSettings } = await import('./toolkit/phone/messages/message-chat-data.js');
    const chats = phoneData().chats || {};
    const lines = [`原版手机入口：${originalPhonePresent() ? '存在（会抢事件）' : '无'}`, `电话系统启用：${phoneData().enabled !== false}`, `工作副本：${phone ? '已加载' : '未加载'}`, `API源：${phoneData().apiConfig?.source || 'default'}`];
    const items = phoneData().promptPreset?.items || [];
    lines.push(`预设条目：${items.length ? items.map(item => `${item.id}:${item.enabled ? '开' : '关'}`).join(', ') : '无（用内置默认）'}`);
    for (const [key, list] of Object.entries(chats)) {
      const id = key.replace(/^chat_/, '');
      const send = getChatSendSettings(id);
      lines.push(`${id}: 共${Array.isArray(list) ? list.length : 0}条，注入最近${send.recentCount}/历史${send.historyCount}`);
    }
    ui('selfcheck-output').textContent = lines.join('\n');
  }));
  ui('export').addEventListener('click', () => runAction(async () => {
    downloadJson(await exportPhoneBackup({ includeSecrets: ui('include-secrets').checked }));
  }));
  ui('import').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (!file) return;
    void runAction(async () => {
      if (file.size > 32 * 1024 * 1024) throw new Error('导入文件超过 32 MiB；请先拆分或整理备份。');
      const value = JSON.parse(await file.text());
      if (!window.confirm('仅替换独立小手机的全部数据；原插件数据保持不变。系统会先备份当前独立文件，导入后需要刷新。确认继续？')) return;
      // Stop generation and close pages before replacing data captured by feature modules.
      if (phone) await phone.disablePhone();
      await flushPhoneStorage();
      await importPhoneBackup(value);
      needsReload = true;
    }).finally(() => { event.target.value = ''; });
  });
  window.addEventListener('standalone-phone-storage-status', updateStatus);
  window.addEventListener('beforeunload', event => {
    if (getStorageStatus().dirty || getStorageStatus().saving) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && getStorageStatus().ready && getStorageStatus().dirty) {
      void flushPhoneStorage().catch(() => updateStatus());
    }
  });
  observer = new MutationObserver(() => {
    if (!originalConflict && originalPhonePresent()) {
      originalConflict = true;
      phone?.closePhoneUI();
      if (phone) void phone.disablePhone().catch(() => updateStatus());
      updateStatus();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

async function initialize() {
  await initPhoneStorage();
  originalConflict = originalPhonePresent();
  if (!originalConflict) await loadPhone();
  updateStatus();
}

export async function startStandalonePhone() {
  if (starting) return starting;
  starting = (async () => {
    mountPanel();
    await runAction(initialize);
  })();
  return starting;
}

// Normal initial load uses APP_READY. A late-loaded extension can start once the
// host document and extension menu already exist; no synthetic event is emitted.
if (eventSource?.once && event_types?.APP_READY) eventSource.once(event_types.APP_READY, startStandalonePhone);
if (document.readyState === 'complete' && document.getElementById('extensionsMenu')) {
  queueMicrotask(() => { void startStandalonePhone(); });
}
