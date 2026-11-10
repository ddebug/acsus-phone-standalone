import { extension_settings, saveSettingsDebounced } from '../../standalone/phone-settings.js';
import logger from '../../logger.js';
import { renderPhoneFrame, closePhoneUI as closeUI } from './phone-main-ui.js';
import { eventSource, event_types } from '/script.js';
import { initPhoneSystem, getPhoneSystem } from './phone-system.js';
import { startProactiveScheduler, stopProactiveScheduler } from './ai-integration/proactive-scheduler.js';

// Adapted from Acsus-Paws-Puffs (AcSus / 白沉 & 溯); see the retained LICENSE.
const EXT_ID = 'acsusStandalonePhone';
const MENU_ID = 'acsus-standalone-phone-menu-entry';
let initPromise = null;
let macrosModulePromise = null;
let macrosActive = false;
let menuReadyHandler = null;
let transitionQueue = Promise.resolve();
let intentVersion = 0;

function enqueueTransition(operation) {
  const result = transitionQueue.then(operation);
  // A rejected operation must not poison later disable/retry operations.
  transitionQueue = result.catch(() => {});
  return result;
}

function setEnabledSetting(enabled) {
  extension_settings[EXT_ID] ??= {};
  extension_settings[EXT_ID].phone ??= {};
  extension_settings[EXT_ID].phone.enabled = enabled;
}

function loadMacros() {
  if (!macrosModulePromise) {
    macrosModulePromise = import('./utils/tavern-macros.js').catch(error => {
      macrosModulePromise = null;
      throw error;
    });
  }
  return macrosModulePromise;
}

async function registerMacros() {
  if (macrosActive) return;
  const { registerPhoneMacros } = await loadMacros();
  // Mark ownership before awaiting so a partially failed registration is cleaned up.
  macrosActive = true;
  await registerPhoneMacros();
}

async function unregisterMacros() {
  // Do not load an unused macro engine just to disable an initially-off phone.
  if (!macrosModulePromise || !macrosActive) return;
  const { unregisterPhoneMacros } = await macrosModulePromise;
  await unregisterPhoneMacros();
  macrosActive = false;
}

/** Idempotent, promise-shared entry; the root may call this after APP_READY. */
export function initPhone() {
  if (initPromise) return initPromise;
  initPromise = enqueueTransition(async () => {
    try {
      const system = await initPhoneSystem();
      if (system.enabled) await registerMacros();
      registerMenuEntry();
      if (system.enabled) startProactiveScheduler(system);
      return system;
    } catch (error) {
      // Cleanup is part of the queued transition, not an out-of-band catch.
      try { await unregisterMacros(); } catch (cleanupError) {
        logger.error('phone', '[Phone] 初始化失败后的宏清理失败:', cleanupError);
      }
      throw error;
    }
  }).catch(error => {
    initPromise = null;
    logger.error('phone', '[Phone] 初始化失败:', error);
    throw error;
  });
  return initPromise;
}

/** Try now (APP_READY may already have fired), then at most one ready retry. */
function registerMenuEntry() {
  let menuItem = document.getElementById(MENU_ID);
  if (!menuItem) {
    const menu = document.querySelector('#extensionsMenu');
    if (!menu) {
      if (!menuReadyHandler) {
        menuReadyHandler = () => {
          const handler = menuReadyHandler;
          menuReadyHandler = null;
          eventSource.off?.(event_types.APP_READY, handler);
          registerMenuEntry();
        };
        if (typeof eventSource.once === 'function') {
          eventSource.once(event_types.APP_READY, menuReadyHandler);
        } else {
          eventSource.on(event_types.APP_READY, menuReadyHandler);
        }
      }
      return null;
    }
    menuItem = document.createElement('div');
    menuItem.id = MENU_ID;
    menuItem.className = 'list-group-item flex-container flexGap5';
    menuItem.innerHTML = '<div class="fa-solid fa-mobile-screen extensionsMenuExtensionButton"></div><span>独立手机</span>';
    menuItem.addEventListener('click', () => {
      openPhoneUI().catch(error => logger.error('phone', '[Phone] 打开失败:', error));
    });
    menu.appendChild(menuItem);
  }
  menuItem.style.display = getPhoneSystem()?.enabled ? '' : 'none';
  if (menuReadyHandler) {
    eventSource.off?.(event_types.APP_READY, menuReadyHandler);
    menuReadyHandler = null;
  }
  return menuItem;
}

/** Never opens an off or partly initialized system. Returns the current overlay. */
export async function openPhoneUI() {
  const system = await initPhone();
  if (!system.enabled || !system.initialized || !system.runtimeInitialized) return null;
  const existing = document.querySelector('.phone-overlay');
  if (existing) return existing;
  const overlay = renderPhoneFrame();
  document.body.appendChild(overlay);
  return overlay;
}

export function closePhoneUI() {
  if (document.querySelector('.phone-overlay')) closeUI();
}

export function enablePhone() {
  const version = ++intentVersion;
  return enqueueTransition(async () => {
    const system = await initPhoneSystem();
    if (version !== intentVersion) return system;
    system.enabled = true;
    try {
      await system.ensureRuntime();
      if (version !== intentVersion) return system;
      await registerMacros();
      if (version !== intentVersion) return system;
      setEnabledSetting(true);
      await saveSettingsDebounced();
      showMenuEntry();
      startProactiveScheduler(system);
      return system;
    } catch (error) {
      if (version === intentVersion) {
        system.enabled = false;
        setEnabledSetting(false);
        try { await unregisterMacros(); } catch (cleanupError) {
          logger.error('phone', '[Phone] 启用失败后的宏清理失败:', cleanupError);
        }
        hideMenuEntry();
        await saveSettingsDebounced();
      }
      throw error;
    }
  });
}

/** Abort immediately; await macro cleanup even if enable/init is still pending. */
export function disablePhone() {
  ++intentVersion;
  stopProactiveScheduler();
  const system = getPhoneSystem();
  if (system) {
    system.enabled = false;
    system.api?.abort();
  }
  setEnabledSetting(false);
  // Hide/close synchronously so an in-flight enable cannot leave a visible UI.
  closePhoneUI();
  hideMenuEntry();
  return enqueueTransition(async () => {
    try {
      await unregisterMacros();
    } finally {
      const current = getPhoneSystem();
      if (current) {
        current.enabled = false;
        current.api?.abort();
      }
      closePhoneUI();
      hideMenuEntry();
      await saveSettingsDebounced();
    }
  });
}

export function showMenuEntry() {
  const menuItem = registerMenuEntry();
  if (menuItem) menuItem.style.display = getPhoneSystem()?.enabled ? '' : 'none';
}

export function hideMenuEntry() {
  const menuItem = document.getElementById(MENU_ID);
  if (menuItem) menuItem.style.display = 'none';
}
