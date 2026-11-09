/**
 * Theme only phone-owned popups mounted outside the phone frame.
 * No body/global theme attributes; observers live only while this frame is open.
 */
import { getTheme } from './theme-manager.js';

/** Notifications may arrive after the phone frame closed: apply saved palette once, no observer. */
export async function applySavedPhoneSurfaceTheme(surface) {
  if (!surface) return;
  const fromFrame = () => {
    const frame = document.querySelector('.phone-container');
    return frame ? frame.dataset.theme || 'light' : null;
  };
  let saved = fromFrame();
  if (!saved) {
    try { saved = await getTheme(); } catch { saved = 'light'; }
  }
  const current = fromFrame() || saved;
  surface.classList.add('phone-theme-surface');
  surface.dataset.phoneThemeOwner = 'standalone';
  surface.dataset.theme = ['dark', 'glass-dark'].includes(current) ? current : 'light';
}

const ROOTS = [
  '.phone-popup-overlay', '.contact-bg-picker-overlay', '.phone-image-preview-overlay',
  '.chat-msg-actions-menu', '.debug-overlay.standalone-phone-debug', '.phone-toast', '.phone-message-notification',
];
const selector = ROOTS.join(',');
const active = new WeakMap();

export function bindPhoneThemeSurfaces(container) {
  if (!container || !document.body || typeof MutationObserver === 'undefined') return;
  releasePhoneThemeSurfaces(container);
  const surfaces = new Set();
  let connected = container.isConnected;
  let ended = false;
  const theme = () => ['dark', 'glass-dark'].includes(container.dataset.theme) ? container.dataset.theme : 'light';
  const sync = surface => {
    surface.classList.add('phone-theme-surface');
    surface.dataset.phoneThemeOwner = 'standalone';
    surface.dataset.theme = theme();
  };
  const add = node => {
    if (node.nodeType !== 1) return;
    const candidates = [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)];
    for (const surface of candidates) {
      if (container.contains(surface)) continue;
      surfaces.add(surface);
      sync(surface);
    }
  };
  const update = () => {
    for (const surface of surfaces) {
      if (!surface.isConnected) surfaces.delete(surface);
      else sync(surface);
    }
  };
  const attributes = new MutationObserver(update);
  attributes.observe(container, { attributes: true, attributeFilter: ['data-theme'] });
  const body = new MutationObserver(records => {
    if (container.isConnected) connected = true;
    else if (connected) { stop(); return; }
    for (const record of records) for (const node of record.addedNodes) add(node);
    for (const surface of surfaces) if (!surface.isConnected) surfaces.delete(surface);
  });
  body.observe(document.body, { childList: true, subtree: true });
  for (const surface of document.querySelectorAll(selector)) add(surface);
  // renderPhoneFrame is inserted immediately by openPhoneUI; bound the detached failure path.
  const timer = setTimeout(() => { if (!container.isConnected) stop(); }, 10000);
  function stop() {
    if (ended) return;
    ended = true;
    attributes.disconnect();
    body.disconnect();
    clearTimeout(timer);
    surfaces.clear();
    active.delete(container);
    // An already-open popup keeps its last palette until it is closed, avoiding a white flash.
  }
  active.set(container, stop);
}

export function releasePhoneThemeSurfaces(container) {
  if (container) active.get(container)?.();
}
