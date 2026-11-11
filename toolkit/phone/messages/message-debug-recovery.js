/** Shared manual-reply UI inside the existing debug popup; no model or data writes. */
import { showConfirmPopup } from '../utils/popup-helper.js';
import { getStorageStatus } from '../../../standalone/phone-settings.js';

const ROOT = '.debug-overlay.standalone-phone-debug';
const VIEW_CONTROLS = '.debug-compare-btn, .debug-validate-btn, .debug-font-minus, .debug-font-plus';
const DESTRUCTIVE_CONTROLS = '.debug-reapply-btn, .debug-reroll-btn';

/**
 * Attach after the existing overlay has been inserted into the document.
 * getState returns the real debug state (or undefined); this shell never creates one.
 * @returns {{isBusy:Function,syncControls:Function,runLegacy:Function,activate:Function,dispose:Function}}
 */
export function attachDebugRecoveryShell(overlay, contactId, {
  getState,
  invalidateSnapshot,
  initialTab = 'raw',
} = {}) {
  const popup = overlay.querySelector('.debug-popup');
  const content = popup?.querySelector('.debug-content');
  const footer = popup?.querySelector('.debug-footer');
  if (!popup || !content || !footer) throw new Error('调试界面暂时不可用。');

  let disposed = false;
  let legacyBusy = false;
  let copyBusy = false;
  let mounting = false;
  let panelBusy = false;
  let panelFaulted = false;
  let panelSaved = false;
  let snapshotInvalidated = false;
  let panel = null;
  let mountPromise = null;
  let activeTab = 'raw';
  const listeners = [];

  const style = document.createElement('style');
  style.textContent = `
    ${ROOT} [hidden] { display:none !important; }
    ${ROOT} .debug-popup { min-height:0; color:var(--phone-text-primary); }
    ${ROOT} .debug-legacy-panel, ${ROOT} .debug-recovery-host {
      display:flex; flex-direction:column; flex:1 1 0; min-width:0; min-height:0; overflow:hidden;
    }
    ${ROOT} .debug-legacy-panel > .debug-content { min-height:0; }
    ${ROOT} .debug-recovery-tabs {
      display:flex; flex:none; gap:6px; padding:8px; border-bottom:1px solid var(--phone-border);
      background:var(--phone-glass-chrome,var(--phone-bg-main));
    }
    ${ROOT} .debug-recovery-tabs .debug-btn { flex:1; white-space:normal; }
    ${ROOT} .debug-recovery-tabs [aria-selected="true"] {
      background:var(--phone-primary); border-color:var(--phone-primary); color:var(--phone-bg-white);
    }
    ${ROOT} .debug-recovery-note, ${ROOT} .debug-recovery-status {
      flex:none; margin:0; padding:7px 10px; font-size:12px; line-height:1.6;
      color:var(--phone-text-secondary); overflow-wrap:anywhere;
      background:var(--phone-glass-chrome,var(--phone-bg-main));
    }
    ${ROOT} .debug-recovery-status { color:var(--phone-danger,var(--phone-text-primary)); }
    ${ROOT} .debug-recovery-tools { flex:none; padding:8px 12px 0; background:var(--phone-bg-main); }
    ${ROOT} .debug-recovery-tools .debug-btn { white-space:normal; }
    ${ROOT} .debug-recovery-mount { display:flex; flex:1 1 0; min-height:0; min-width:0; overflow:hidden; }
    ${ROOT} .debug-recovery-host { background:var(--phone-bg-main); }
    ${ROOT} :is(button,textarea):focus-visible { outline:2px solid var(--phone-primary); outline-offset:2px; }
    ${ROOT} button:disabled { opacity:.5; cursor:default; }
    ${ROOT} .debug-textarea { min-height:0; box-sizing:border-box; }
  `;
  const tabs = node('div', 'debug-recovery-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '消息调试方式');
  const rawTab = button('调用调试');
  const recoveryTab = button('补录角色回复');
  rawTab.setAttribute('role', 'tab');
  recoveryTab.setAttribute('role', 'tab');
  tabs.append(rawTab, recoveryTab);
  const note = node('p', 'debug-recovery-note',
    '重新应用会回退后重新解析；补录只追加一条纯文本回复。重roll 会调用模型，可能收费。切换页签或填入原文不会调用模型。');
  const legacy = node('div', 'debug-legacy-panel');
  legacy.setAttribute('role', 'tabpanel');
  content.before(legacy);
  legacy.append(content, footer);
  const host = node('div', 'debug-recovery-host');
  host.setAttribute('role', 'tabpanel');
  host.hidden = true;
  const tools = node('div', 'debug-recovery-tools');
  const copyButton = button('使用当前调试框内容');
  tools.append(copyButton);
  const mount = node('div', 'debug-recovery-mount');
  host.append(tools, mount);
  const status = node('p', 'debug-recovery-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  legacy.before(style, tabs, note);
  legacy.after(host, status);

  function stateNow() {
    try { return typeof getState === 'function' ? getState() : undefined; }
    catch { return undefined; }
  }

  function hasVersions(state) {
    return Array.isArray(state?.versions) && state.versions.length > 0;
  }

  function snapshotIsSafe(state) {
    return state?.hasSnapshot === true && hasVersions(state) &&
      Number.isSafeInteger(state?.snapshot?.messageCount) && state.snapshot.messageCount >= 0;
  }

  function live() {
    return !disposed && overlay.isConnected;
  }

  function storageAvailable() {
    const value = getStorageStatus();
    return value.ready && !value.blocked && !value.importing && !value.error;
  }

  function isBusy() {
    return !disposed && (legacyBusy || copyBusy || mounting || panelBusy || Boolean(panel?.isBusy()));
  }

  function recoveryLocked() {
    return panelFaulted || panelSaved || Boolean(panel?.isFaulted());
  }

  function setStatus(text = '') {
    if (disposed) return;
    status.textContent = text;
    status.hidden = !text;
  }

  function sourceNow() {
    // The readonly example in compare mode is never a recovery source.
    const textarea = legacy.querySelector('.debug-textarea:not([readonly]):not(.debug-textarea-readonly)');
    const text = textarea?.value || '';
    const state = stateNow();
    const version = Array.isArray(state?.versions) ? state.versions[state.currentIndex] : undefined;
    const milliseconds = version?.timestamp;
    const time = typeof milliseconds === 'number' && Number.isFinite(milliseconds) &&
      Number.isFinite(new Date(milliseconds).getTime()) ? Math.floor(milliseconds / 1000) : undefined;
    return { text, time };
  }

  function syncControls() {
    if (disposed) return;
    const state = stateNow();
    const busy = isBusy();
    const recovery = activeTab === 'recovery';
    const versions = hasVersions(state);
    const index = state?.currentIndex;
    const validIndex = versions && Number.isInteger(index) && index >= 0 && index < state.versions.length;
    legacy.hidden = recovery;
    host.hidden = !recovery;
    popup.setAttribute('aria-busy', String(busy));
    rawTab.setAttribute('aria-selected', String(!recovery));
    recoveryTab.setAttribute('aria-selected', String(recovery));
    rawTab.tabIndex = recovery ? -1 : 0;
    recoveryTab.tabIndex = recovery ? 0 : -1;
    rawTab.disabled = busy;
    recoveryTab.disabled = busy;
    popup.querySelectorAll('.debug-close-btn').forEach(control => { control.disabled = busy; });
    popup.querySelectorAll(VIEW_CONTROLS).forEach(control => {
      control.hidden = recovery;
      control.disabled = busy || (control.matches('.debug-compare-btn, .debug-validate-btn') && !versions);
    });
    popup.querySelectorAll(DESTRUCTIVE_CONTROLS).forEach(control => {
      control.disabled = busy || recovery || recoveryLocked() || !snapshotIsSafe(state) || !storageAvailable();
    });
    legacy.querySelectorAll('.debug-version-prev').forEach(control => {
      control.disabled = busy || !validIndex || index <= 0;
    });
    legacy.querySelectorAll('.debug-version-next').forEach(control => {
      control.disabled = busy || !validIndex || index >= state.versions.length - 1;
    });
    // Do not make the editable raw source readonly: it remains available for explicit copying.
    // Legacy actions/close are gated below, and the panel owns its own write locks.
    host.inert = legacyBusy || copyBusy;
    copyButton.disabled = busy || !panel || recoveryLocked();
  }

  function onPanelState(next = {}) {
    if (disposed) return;
    panelBusy = next.busy === true;
    panelFaulted = panelFaulted || next.faulted === true;
    panelSaved = panelSaved || next.saved === true;
    if ((panelSaved || panelFaulted) && !snapshotInvalidated) {
      // Latch before notifying the owner, including when its callback throws.
      snapshotInvalidated = true;
      try {
        invalidateSnapshot?.();
        setStatus(panelFaulted
          ? '补录写入结果不明，旧回退快照也已停用。请先保留原文并备份手机数据，再刷新确认。'
          : '补录已保存；为避免回退删除新消息，旧快照已停用。新一轮正常调用会建立新快照。');
      } catch { setStatus('旧调试回退已停用；请保留原文并检查手机存储状态。'); }
    }
    syncControls();
  }

  function ensurePanel() {
    if (mountPromise) return mountPromise;
    if (!live()) return Promise.resolve(null);
    const source = sourceNow();
    const initialText = /^错误[:：]/.test(source.text.trimStart()) ? '' : source.text;
    mounting = true;
    syncControls();
    mountPromise = (async () => {
      try {
        const { renderManualReplyPanel } = await import('./manual-reply-ui.js');
        if (!live()) return null;
        const result = await renderManualReplyPanel({
          contactId, initialText, initialTime: source.time, onStateChange: onPanelState,
        });
        if (!live()) return null;
        panel = result;
        mount.append(result.fragment);
        panelBusy = result.isBusy();
        panelFaulted = panelFaulted || result.isFaulted();
        return result;
      } catch {
        if (live()) setStatus('补录面板暂时无法打开，请关闭窗口后重试。');
        return null;
      } finally {
        mounting = false;
        if (live()) syncControls();
      }
    })();
    return mountPromise;
  }

  /** Synchronous tab activation; panel preparation is lazy and only happens once. */
  function activate(tab) {
    if (disposed || isBusy() || (tab !== 'raw' && tab !== 'recovery')) return false;
    activeTab = tab;
    syncControls();
    if (tab === 'recovery') void ensurePanel();
    return true;
  }

  /** Lock before calling the existing handler; never implicitly execute a handler. */
  async function runLegacy(asyncCallback, { requiresSnapshot = false } = {}) {
    if (!live() || isBusy() || activeTab !== 'raw' || typeof asyncCallback !== 'function') return false;
    if (requiresSnapshot && (recoveryLocked() || !snapshotIsSafe(stateNow()))) {
      setStatus('当前没有可安全回退的调试快照；请使用补录角色回复。');
      syncControls();
      return false;
    }
    if (requiresSnapshot && !storageAvailable()) {
      setStatus('手机存储未就绪或写入未确认，请先保留备份并处理存储提示；没有执行回退或模型请求。');
      syncControls();
      return false;
    }
    legacyBusy = true;
    setStatus();
    syncControls();
    try {
      await asyncCallback();
      return true;
    } catch {
      if (live()) setStatus('调试操作未完成，请检查当前状态后重试。');
      return false;
    } finally {
      legacyBusy = false;
      if (live()) syncControls();
    }
  }

  async function copyCurrentSource() {
    if (!live() || isBusy() || !panel || recoveryLocked()) return;
    const source = sourceNow();
    if (!source.text.trim()) {
      setStatus('当前调试框没有可使用的内容。');
      return;
    }
    if (/^错误[:：]/.test(source.text.trimStart())) {
      setStatus('错误提示不能作为角色回复；请先粘贴角色最终回复。');
      return;
    }
    copyBusy = true;
    setStatus();
    syncControls();
    try {
      // Safe non-replacing attempt also detects a different existing draft.
      if (panel.setSourceText(source.text, { time: source.time })) return;
      if (recoveryLocked() || panel.isBusy() || !panel.hasDraft()) return;
      const confirmed = await showConfirmPopup(
        '替换补录草稿',
        '补录面板已有不同草稿。使用当前调试框内容会替换草稿并清除预览，是否继续？',
        { okButton: '替换草稿', cancelButton: '保留草稿', danger: true },
      );
      if (!confirmed || !live() || recoveryLocked() || panel.isBusy()) return;
      // replace:true is used only after explicit confirmation, never on tab changes.
      if (!panel.setSourceText(source.text, { time: source.time, replace: true })) {
        setStatus('当前无法替换草稿，请保留原文并检查面板状态。');
      }
    } catch {
      if (live()) setStatus('暂时无法使用调试框内容；草稿未主动替换。');
    } finally {
      copyBusy = false;
      if (live()) syncControls();
    }
  }

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  }
  listen(rawTab, 'click', () => activate('raw'));
  listen(recoveryTab, 'click', () => activate('recovery'));
  listen(copyButton, 'click', () => { void copyCurrentSource(); });
  listen(tabs, 'keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'raw' : event.key === 'End' ? 'recovery' :
      activeTab === 'raw' ? 'recovery' : 'raw';
    if (activate(next)) (next === 'raw' ? rawTab : recoveryTab).focus();
  });
  // Capture guards also stop synthetic clicks on disabled controls from reaching old handlers.
  listen(overlay, 'click', event => {
    const target = event.target;
    const control = target?.closest?.(`.debug-close-btn, ${VIEW_CONTROLS}, ${DESTRUCTIVE_CONTROLS}, .debug-version-prev, .debug-version-next`);
    const destructive = control?.matches(DESTRUCTIVE_CONTROLS);
    if ((isBusy() && (target === overlay || control)) ||
      (destructive && (activeTab !== 'raw' || recoveryLocked() || !snapshotIsSafe(stateNow())))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  function dispose() {
    if (disposed) return;
    disposed = true;
    listeners.splice(0).forEach(remove => remove());
    // Detached async render results are discarded; the shared panel installs no global listeners.
    panel = null;
  }

  activate(hasVersions(stateNow()) && initialTab !== 'recovery' ? 'raw' : 'recovery');
  return { isBusy, syncControls, runLegacy, activate, dispose };
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(text) {
  const element = node('button', 'debug-btn', text);
  element.type = 'button';
  return element;
}
