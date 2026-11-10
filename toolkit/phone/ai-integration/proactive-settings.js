/** Opt-in proactive-message settings only; no timers, model calls or chat writes. */
import {
  extension_settings,
  saveSettingsDebounced,
  flushPhoneStorage,
} from '../../../standalone/phone-settings.js';

export const DEFAULT_PROACTIVE_SETTINGS = Object.freeze({
  enabled: false,
  idleEnabled: true,
  idleMinutes: 120,
  times: Object.freeze([]),
  dailyLimit: 5,
  contactIds: Object.freeze([]),
});

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const SETTING_KEYS = Object.keys(DEFAULT_PROACTIVE_SETTINGS);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validContactId = value => typeof value === 'string' && value.trim().length > 0;
const validTime = value => typeof value === 'string' && value.length === 5 && TIME_PATTERN.test(value);
const inIntegerRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function detached(settings) {
  return { ...settings, times: [...settings.times], contactIds: [...settings.contactIds] };
}

/**
 * Sanitize legacy/stored values without changing storage or trusting truthy flags.
 * Invalid list entries are dropped, valid entries retained, and overlong lists bounded.
 * Incomplete enabled configurations are disabled rather than implicitly opting in.
 */
export function normalizeProactiveSettings(value) {
  const source = isRecord(value) ? value : {};
  const settings = {
    enabled: own(source, 'enabled') && source.enabled === true,
    idleEnabled: own(source, 'idleEnabled') && typeof source.idleEnabled === 'boolean'
      ? source.idleEnabled : DEFAULT_PROACTIVE_SETTINGS.idleEnabled,
    idleMinutes: own(source, 'idleMinutes') && inIntegerRange(source.idleMinutes, 15, 10080)
      ? source.idleMinutes : DEFAULT_PROACTIVE_SETTINGS.idleMinutes,
    times: own(source, 'times') && Array.isArray(source.times)
      ? [...new Set(source.times.filter(validTime))].sort().slice(0, 12)
      : [],
    dailyLimit: own(source, 'dailyLimit') && inIntegerRange(source.dailyLimit, 1, 50)
      ? source.dailyLimit : DEFAULT_PROACTIVE_SETTINGS.dailyLimit,
    contactIds: own(source, 'contactIds') && Array.isArray(source.contactIds)
      ? [...new Set(source.contactIds.filter(validContactId))].slice(0, 100)
      : [],
  };
  if (!settings.contactIds.length || (!settings.idleEnabled && !settings.times.length)) {
    settings.enabled = false;
  }
  return settings;
}

/** Return a normalized DETACHED copy; reading never initializes or saves settings. */
export function getProactiveSettings() {
  return normalizeProactiveSettings(extension_settings.acsusStandalonePhone.phone?.proactiveSettings);
}

/**
 * Strictly validate a complete configuration and return its detached canonical form.
 * Contact existence belongs to the UI/runtime; this module validates IDs, not contact data.
 */
export function validateProactiveSettings(value) {
  if (!isRecord(value)) throw new TypeError('主动消息设置必须是对象。');
  for (const key of SETTING_KEYS) {
    if (!own(value, key)) throw new TypeError(`主动消息设置缺少 ${key}。`);
  }
  if (typeof value.enabled !== 'boolean' || typeof value.idleEnabled !== 'boolean') {
    throw new TypeError('启用状态与沉默触发状态必须是布尔值。');
  }
  if (!inIntegerRange(value.idleMinutes, 15, 10080)) {
    throw new RangeError('沉默时长必须是 15–10080 分钟的整数。');
  }
  if (!inIntegerRange(value.dailyLimit, 1, 50)) {
    throw new RangeError('每日实际消息上限必须是 1–50 的整数。');
  }
  if (!Array.isArray(value.times)
    || Array.from(value.times).some(time => !validTime(time))) {
    throw new TypeError('固定时刻必须是 HH:mm 格式的数组，例如 22:30。');
  }
  const times = [...new Set(value.times)].sort();
  if (times.length > 12) throw new RangeError('每天最多设置 12 个不同的固定时刻。');
  if (!Array.isArray(value.contactIds) || Array.from(value.contactIds).some(id => !validContactId(id))) {
    throw new TypeError('允许角色必须是非空字符串 ID 的数组。');
  }
  const contactIds = [...new Set(value.contactIds)];
  if (contactIds.length > 100) throw new RangeError('最多允许 100 个角色。');
  if (value.enabled && !contactIds.length) throw new RangeError('启用前请至少选择一个允许角色。');
  if (value.enabled && !value.idleEnabled && !times.length) {
    throw new RangeError('启用前请开启沉默触发，或设置至少一个固定时刻。');
  }
  return {
    enabled: value.enabled,
    idleEnabled: value.idleEnabled,
    idleMinutes: value.idleMinutes,
    times,
    dailyLimit: value.dailyLimit,
    contactIds,
  };
}

// Serialize only this module's saves. Never replace the phone namespace on rollback.
let saveQueue = Promise.resolve();

/**
 * Merge a strict partial update and resolve only after independent storage readback.
 * Failed/ambiguous storage writes are not retried; storage recovery belongs to its facade.
 */
export function saveProactiveSettings(updates) {
  if (!isRecord(updates)) return Promise.reject(new TypeError('设置更新必须是对象。'));
  let patch;
  try {
    const keys = Object.keys(updates);
    if (keys.some(key => !SETTING_KEYS.includes(key))) throw new TypeError('包含不支持的主动消息设置。');
    patch = {};
    for (const key of keys) {
      // Snapshot caller-owned arrays now, before a queued save can yield.
      patch[key] = Array.isArray(updates[key]) ? [...updates[key]] : updates[key];
    }
  } catch (error) {
    return Promise.reject(error);
  }

  const operation = saveQueue.then(async () => {
    const phone = extension_settings.acsusStandalonePhone.phone;
    if (!isRecord(phone)) throw new Error('手机存储尚未准备好，请重新打开页面。');
    const next = validateProactiveSettings({ ...getProactiveSettings(), ...patch });
    const hadPrevious = own(phone, 'proactiveSettings');
    const previous = phone.proactiveSettings;
    phone.proactiveSettings = next;
    try {
      // Attach both rejection handlers before awaiting; flush bypasses the debounce delay.
      const pending = saveSettingsDebounced();
      await Promise.all([pending, flushPhoneStorage()]);
      if (extension_settings.acsusStandalonePhone.phone !== phone || phone.proactiveSettings !== next) {
        throw new Error('保存期间设置已被其他操作替换，请重新打开页面确认。');
      }
    } catch (error) {
      // A different writer owns any replacement. Leave its values and every sibling alone.
      if (phone.proactiveSettings === next) {
        if (hadPrevious) phone.proactiveSettings = previous;
        else delete phone.proactiveSettings;
      }
      throw error;
    }

    const saved = detached(next);
    globalThis.dispatchEvent(new CustomEvent('standalone-phone-proactive-settings-changed', {
      detail: { settings: detached(saved) },
    }));
    return saved;
  });
  saveQueue = operation.catch(() => {});
  return operation;
}
