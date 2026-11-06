/**
 * Compatibility facade for this extension only. It never imports or references
 * the host's extension_settings/saveSettings/settings.json. Initialization is
 * explicit; no file is read or written merely by importing this module.
 */
import { getRequestHeaders } from '/script.js';
import { createPhoneFileStore } from './file-store.js';

// Keep both facade and namespace identity stable. Only .phone is replaced after
// a verified initial load/import; consumers should reload after importing.
const phoneNamespace = { phone: {} };
export const extension_settings = Object.freeze({ acsusStandalonePhone: phoneNamespace });

function randomId() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

const store = createPhoneFileStore({
    fetch: (...args) => globalThis.fetch(...args),
    getRequestHeaders: () => getRequestHeaders(),
    getPhone: () => phoneNamespace.phone,
    replacePhone: phone => { phoneNamespace.phone = phone; },
    randomId,
    withLock: operation => globalThis.navigator?.locks
        ? globalThis.navigator.locks.request('acsus-phone-standalone-writer', { mode: 'exclusive' }, operation)
        : operation(),
    onStatus: status => {
        globalThis.dispatchEvent(new CustomEvent('standalone-phone-storage-status', { detail: status }));
    },
});

/** Read only the independent file once. Failure never resets host/user data. */
export const initPhoneStorage = store.initPhoneStorage;
/** Mark live phone memory dirty and return an awaitable, safely observed promise. */
export const saveSettingsDebounced = store.saveSettingsDebounced;
/** Drain serialized writes; blocked or uncertain writes require export + reload. */
export const flushPhoneStorage = store.flushPhoneStorage;
/** Read status only; error objects contain no response body or phone contents. */
export const getStorageStatus = store.getStorageStatus;
/** Return a detached JSON envelope; secrets are excluded unless explicitly opted in. */
export const exportPhoneBackup = store.exportPhoneBackup;
/** Import a selected JSON object/text after verified backup; never migrate secrets. */
export const importPhoneBackup = store.importPhoneBackup;
