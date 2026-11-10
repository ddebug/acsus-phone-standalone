/**
 * Opt-in, independent-phone proactive messages. Importing has no side effects.
 * Web Locks coordinate same-origin live pages; the file writer's revision guard
 * is the second line of defence. There is no cross-device atomic transaction:
 * use ONE live phone page/device. Browser suspension is not an offline service.
 */
import {
  extension_settings,
  saveSettingsDebounced,
  flushPhoneStorage,
  getStorageStatus,
} from '../../../standalone/phone-settings.js';
import { saveChatMessage } from '../messages/message-chat-data.js';
import { getProactiveSettings } from './proactive-settings.js';
import { persistCharacterExtrasTurn } from './character-extras-integration.js';

const PERIOD = 900000;
// setInterval/lock/storage micro-jitter must not turn a 15m check into every other tick.
const MIN_GAP = PERIOD - 5000;
const REQUEST_TIMEOUT = 120000;
const SETTINGS_EVENT = 'standalone-phone-proactive-settings-changed';
const USER_EVENT = 'standalone-phone-user-message-saved';
const LOCK_NAME = 'standalone-phone-proactive-run';
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
let runtime = null;
let localBusy = false;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const phoneData = () => extension_settings.acsusStandalonePhone.phone;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const pad = value => String(value).padStart(2, '0');
const dayOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const quiet = date => date.getHours() >= 1 && date.getHours() < 9;
const enabled = run => runtime === run && !run.paused && run.system.enabled === true
  && run.system.runtimeInitialized === true;
const normalBusy = api => Boolean(api?.isGenerating) || Number(api?.foregroundPending) > 0;
const storageReady = () => {
  const status = getStorageStatus();
  return status.ready && !status.blocked && !status.importing && !status.error;
};

// Only fingerprints, IDs, times and outcomes enter scheduler metadata. Neither
// the hidden prompt nor reply text is ever placed in state/logs/pending/debug.
function fingerprint(value) {
  const text = JSON.stringify(value) ?? '';
  let a = 2166136261;
  let b = 2246822507;
  for (let index = 0; index < text.length; index++) {
    a = Math.imul(a ^ text.charCodeAt(index), 16777619);
    b = Math.imul(b ^ text.charCodeAt(index), 3266489909);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

function latestUser(phone, contactId) {
  const history = phone.chats?.[`chat_${contactId}`];
  if (!Array.isArray(history)) return { key: 'none', index: -1, time: 0, identity: 'none' };
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.sender !== 'user') continue;
    const rawTime = Number(message.time);
    const time = Number.isFinite(rawTime) && rawTime > 0
      ? (rawTime < 1e12 ? rawTime * 1000 : rawTime) : 0;
    return {
      key: `user:${fingerprint([message.id ?? null, message.time ?? null, index, message])}`,
      identity: fingerprint([message.id ?? null, message.time ?? null]),
      index,
      time,
    };
  }
  return { key: 'none', index: -1, time: 0, identity: 'none' };
}

function hasNewUser(entry, user) {
  if (!entry.awaitingUserKey) return true;
  if (user.key === 'none' || user.key === entry.awaitingUserKey) return false;
  if (entry.awaitingUserKey === 'none') return true;
  // Editing/deleting the same message is not a new human turn. Missing legacy
  // marker coordinates fail closed rather than releasing an uncertain attempt.
  return record(entry.awaitingUser) && user.identity !== entry.awaitingUser.identity
    && (user.time > entry.awaitingUser.time || user.index > entry.awaitingUser.index);
}

function sourceKey(phone, contactId) {
  const contact = Array.isArray(phone.contacts) ? phone.contacts.find(item => item?.id === contactId) : null;
  if (!contact) return null;
  return fingerprint([
    contact, phone.chats?.[`chat_${contactId}`] ?? [], phone.userProfile ?? null,
    phone.apiConfig ?? null, phone.promptPreset ?? null,
    phone.characterPrompts?.[contactId] ?? null, phone.chatSendSettings?.[contactId] ?? null,
    phone.diaries?.[contactId] ?? null, phone.diarySettings?.enabled !== false,
  ]);
}

function getState(phone, day) {
  if (phone.proactiveState !== undefined && !record(phone.proactiveState)) return null;
  const state = phone.proactiveState ??= {
    day, sent: 0, attempts: 0, lastCheckAt: 0, contacts: {},
  };
  if (!record(state.contacts)) return null;
  if (state.day !== day) {
    // Preserve awaiting-user markers and cooldown across midnight/reloads.
    // Refuse a backwards clock/day instead of reopening a previous day's budget.
    if (typeof state.day === 'string' && state.day > day) return null;
    state.day = day;
    state.sent = 0;
    state.attempts = 0;
    for (const entry of Object.values(state.contacts)) {
      if (record(entry)) entry.slots = { day, times: [] };
    }
  }
  if (!Number.isSafeInteger(state.sent) || state.sent < 0
    || !Number.isSafeInteger(state.attempts) || state.attempts < 0) return null;
  return state;
}

async function persist() {
  // Observe both promises immediately; legacy saver callers may swallow errors.
  const pending = saveSettingsDebounced();
  await Promise.all([pending, flushPhoneStorage()]);
  if (!storageReady()) throw new Error('storage-unverified');
}

function dueSlots(settings, date, entry) {
  const day = dayOf(date);
  const used = entry.slots?.day === day && Array.isArray(entry.slots.times) ? entry.slots.times : [];
  return settings.times.filter(slot => {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot) || used.includes(slot)) return false;
    const [hour, minute] = slot.split(':').map(Number);
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
    // Same local date only; no overnight catch-up and no DST-normalized slot.
    const elapsed = date.getTime() - at.getTime();
    return at.getHours() === hour && at.getMinutes() === minute && elapsed >= 0 && elapsed < PERIOD;
  });
}

function silenceText(user, now) {
  if (user.key === 'none' || !user.time) return '未知时长';
  const seconds = Math.max(0, Math.floor((now - user.time) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}小时${minutes % 60}分钟` : `${Math.floor(hours / 24)}天${hours % 24}小时`;
}

function hiddenPrompt(user, date) {
  const clock = `${dayOf(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `[系统：现在是${clock}，user已经${silenceText(user, date.getTime())}没说话了。你可以主动给她发消息，也可以不发。如果不想发，只回复[不发]。]`;
}

function abortFlight(run, reason) {
  const flight = run.flight;
  if (!flight) return;
  flight.reason = reason;
  flight.controller.abort();
  // This API is expressly background-only; never abort normal user generation.
  try { run.system.api?.abortProactive?.(); } catch { /* No private error details. */ }
}

async function request(run, contactId, user) {
  const controller = new AbortController();
  const flight = { contactId, controller, reason: 'aborted' };
  run.flight = flight;
  let rejectAbort;
  const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error('aborted'));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timeout = globalThis.setTimeout(() => abortFlight(run, 'timeout'), REQUEST_TIMEOUT);
  try {
    // Promise.race bounds the lock even if an adapter ignores AbortSignal. A late
    // resolution/rejection is observed but can never write/present a message.
    return await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('aborted');
        return run.system.api.requestProactiveMessage(contactId, hiddenPrompt(user, new Date()), {
          signal: controller.signal,
        });
      }),
      aborted,
    ]);
  } finally {
    globalThis.clearTimeout(timeout);
    controller.signal.removeEventListener('abort', onAbort);
    if (run.flight === flight) run.flight = null;
  }
}

function stillValid(run, phone, state, settingsKey, contactId, user, source, api) {
  const now = new Date();
  const settings = getProactiveSettings();
  return enabled(run) && !run.faulted && storageReady() && !quiet(now)
    && dayOf(now) === state.day && phoneData() === phone && phone.proactiveState === state
    && run.system.api === api && !normalBusy(api) && settings.enabled === true
    && fingerprint(settings) === settingsKey && settings.contactIds.includes(contactId)
    && state.sent < settings.dailyLimit && latestUser(phone, contactId).key === user.key
    && sourceKey(phone, contactId) === source;
}

async function attempt(run, phone, state, settings, contactId, entry, user, slots) {
  const settingsKey = fingerprint(settings);
  const source = sourceKey(phone, contactId);
  const api = run.system.api;
  if (!source || !stillValid(run, phone, state, settingsKey, contactId, user, source, api)) return;
  const requestId = globalThis.crypto.randomUUID();
  const now = Date.now();
  // Reserve and verify BEFORE network. Errors, reloads and ambiguous outcomes
  // keep this marker until a new human turn; fixed slots are consumed now.
  state.attempts++;
  entry.lastAttemptAt = now;
  entry.awaitingUserKey = user.key;
  entry.awaitingUser = { index: user.index, time: user.time, identity: user.identity };
  entry.lastOutcome = 'reserved';
  entry.proactiveRequestId = requestId;
  entry.slots = {
    day: state.day,
    times: [...new Set([...(entry.slots?.day === state.day ? entry.slots.times ?? [] : []), ...slots])],
  };
  await persist();
  if (!stillValid(run, phone, state, settingsKey, contactId, user, source, api)) {
    entry.lastOutcome = 'discarded';
    await persist();
    return;
  }

  let response;
  try {
    response = await request(run, contactId, user);
  } catch {
    entry.lastOutcome = 'error';
    entry.lastError = 'request-failed-or-aborted';
    await persist();
    return;
  }
  if (!stillValid(run, phone, state, settingsKey, contactId, user, source, api)) {
    entry.lastOutcome = 'discarded';
    await persist();
    return;
  }
  const responseText = typeof response === 'string' ? response : response?.text;
  if (typeof responseText !== 'string' || !responseText.trim()) {
    entry.lastOutcome = 'invalid-response';
    await persist();
    return;
  }
  const text = responseText.trim();
  if (text === '[不发]') {
    const marker = entry.awaitingUser;
    entry.lastOutcome = 'no-send';
    delete entry.awaitingUserKey;
    delete entry.awaitingUser;
    delete entry.lastError;
    try { await persist(); }
    catch (error) {
      // An unverified no-send must not reopen eligibility in this live page.
      entry.awaitingUserKey = user.key;
      entry.awaitingUser = marker;
      throw error;
    }
    return;
  }

  // Lead's API guarantees ONE plain-text response, never operations/tool output.
  // Reserve the bubble count and awaiting marker before saver snapshots the SAME
  // file. Failed/uncertain saves are never retried and never presented.
  const sentAt = new Date();
  if (quiet(sentAt) || dayOf(sentAt) !== state.day || !enabled(run)) {
    entry.lastOutcome = 'discarded';
    await persist();
    return;
  }
  const message = {
    id: globalThis.crypto.randomUUID(),
    apiCallId: response?.extrasTurn?.id || requestId,
    type: 'text', sender: 'contact', content: text,
    time: Math.floor(sentAt.getTime() / 1000), proactive: true, proactiveRequestId: requestId,
  };
  state.sent++;
  entry.lastOutcome = 'sent';
  delete entry.lastError;
  await saveChatMessage(contactId, message, { strict: true });
  await flushPhoneStorage();
  if (!storageReady() || phoneData() !== phone || phone.proactiveState !== state
    || !phone.chats?.[`chat_${contactId}`]?.some(item => item.id === message.id
      && item.proactiveRequestId === requestId)) throw new Error('storage-unverified');
  // 小剧场只关联这条已确认写入的消息，既不新增气泡也不回灌下次请求。
  try {
    await persistCharacterExtrasTurn(response?.extrasTurn, response?.extrasBlocks,
      new Map([[contactId, new Set([message.id])]]));
  } catch { /* Ordinary message remains saved; no model retry for a sidecar. */ }
  // Presentation is downstream of verified persistence only. Its failure must
  // not lead to retrying the stored bubble, decrementing budget or clearing await.
  try {
    const { presentProactiveMessage } = await import('./proactive-presenter.js');
    if (enabled(run)) await presentProactiveMessage(contactId, message);
  } catch { /* Saved successfully; no false notification or replay. */ }
}

async function tickLocked(run) {
  if (!enabled(run) || run.faulted || !storageReady() || normalBusy(run.system.api)
    || globalThis.navigator?.onLine === false
    || typeof run.system.api?.requestProactiveMessage !== 'function') return;
  const settings = getProactiveSettings();
  const date = new Date();
  if (!settings.enabled || quiet(date)) return;
  const phone = phoneData();
  if (!record(phone)) return;
  const state = getState(phone, dayOf(date));
  if (!state) return;
  const now = date.getTime();
  // Durable check throttle: start/refresh/settings events cannot produce bursts.
  // Clock rollback also fails closed until wall time catches up.
  if (count(state.lastCheckAt) > 0 && now - state.lastCheckAt < MIN_GAP) return;
  state.lastCheckAt = now;
  await persist();
  const requestCap = Math.max(20, settings.dailyLimit * 4);
  for (const contactId of settings.contactIds) {
    if (!enabled(run) || run.faulted || !storageReady() || normalBusy(run.system.api)
      || quiet(new Date()) || dayOf(new Date()) !== state.day
      || state.sent >= settings.dailyLimit || state.attempts >= requestCap
      || fingerprint(getProactiveSettings()) !== fingerprint(settings)) break;
    if (typeof contactId !== 'string' || UNSAFE_KEYS.has(contactId) || !sourceKey(phone, contactId)) continue;
    let entry = own(state.contacts, contactId) ? state.contacts[contactId] : undefined;
    if (entry !== undefined && !record(entry)) continue;
    if (!entry) entry = state.contacts[contactId] = {};
    if (count(entry.lastAttemptAt) > 0 && Date.now() - entry.lastAttemptAt < MIN_GAP) continue;
    const user = latestUser(phone, contactId);
    if (!hasNewUser(entry, user)) continue;
    const current = new Date();
    const slots = dueSlots(settings, current, entry);
    const idle = settings.idleEnabled && user.key !== 'none' && user.time > 0
      && current.getTime() - user.time >= settings.idleMinutes * 60000;
    if (!slots.length && !idle) continue;
    await attempt(run, phone, state, settings, contactId, entry, user, slots);
  }
}

async function tick(run) {
  if (localBusy || !enabled(run) || run.faulted) return;
  localBusy = true;
  try {
    if (globalThis.navigator?.locks?.request) {
      await globalThis.navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async lock => {
        if (lock) await tickLocked(run);
      });
    }
    // Unsafe origins without Web Locks must not make unattended paid requests.
    // The file's preflight/readback is not an atomic cross-tab compare-and-swap.
  } catch {
    // Only sanitized metadata, no raw network/storage errors. A storage fault is
    // latched until stop/start (the facade itself may require a page reload).
    run.faulted = true;
  } finally { localBusy = false; }
}

function clearIntervalFor(run) {
  if (run.timer !== null) globalThis.clearInterval(run.timer);
  run.timer = null;
}

function arm(run) {
  if (!enabled(run) || run.timer !== null) return;
  run.timer = globalThis.setInterval(() => {
    if (!enabled(run)) { stopProactiveScheduler(); return; }
    void tick(run);
  }, PERIOD);
  void tick(run);
}

/** Read-only UI diagnostics; no initialization, timers, requests or chat content. */
export function getProactiveSchedulerStatus() {
  const state = phoneData()?.proactiveState;
  const today = dayOf(new Date());
  return {
    supported: typeof globalThis.navigator?.locks?.request === 'function',
    running: Boolean(runtime && enabled(runtime)),
    faulted: runtime?.faulted === true,
    sent: state?.day === today ? count(state.sent) : 0,
    attempts: state?.day === today ? count(state.attempts) : 0,
    lastCheckAt: count(state?.lastCheckAt),
    outcomes: getProactiveSettings().contactIds.map(contactId => {
      const entry = state?.contacts?.[contactId];
      return { contactId, outcome: typeof entry?.lastOutcome === 'string' ? entry.lastOutcome : '' };
    }),
  };
}

/** Start once after runtime init/enable. Closing the phone UI is NOT a stop. */
export function startProactiveScheduler(system) {
  if (!system || system.enabled !== true || system.runtimeInitialized !== true) {
    stopProactiveScheduler();
    return;
  }
  if (runtime?.system === system) return;
  stopProactiveScheduler();
  const run = { system, timer: null, flight: null, paused: false, faulted: false };
  runtime = run;
  run.onSettings = () => {
    abortFlight(run, 'settings-changed');
    // Do not reset durable lastCheckAt/lastAttemptAt or bypass the 15m throttle.
    void tick(run);
  };
  run.onUser = event => {
    if (event.detail?.contactId === run.flight?.contactId) abortFlight(run, 'user-message');
  };
  run.onHide = () => {
    run.paused = true;
    clearIntervalFor(run);
    abortFlight(run, 'page-hidden');
  };
  run.onShow = () => {
    if (runtime !== run) return;
    run.paused = false;
    if (enabled(run)) arm(run);
    else stopProactiveScheduler();
  };
  globalThis.addEventListener(SETTINGS_EVENT, run.onSettings);
  globalThis.addEventListener(USER_EVENT, run.onUser);
  globalThis.addEventListener('pagehide', run.onHide);
  globalThis.addEventListener('pageshow', run.onShow);
  arm(run);
}

/** Idempotent teardown; abort only background work and remove every listener. */
export function stopProactiveScheduler() {
  const run = runtime;
  if (!run) return;
  runtime = null;
  clearIntervalFor(run);
  abortFlight(run, 'stopped');
  globalThis.removeEventListener(SETTINGS_EVENT, run.onSettings);
  globalThis.removeEventListener(USER_EVENT, run.onUser);
  globalThis.removeEventListener('pagehide', run.onHide);
  globalThis.removeEventListener('pageshow', run.onShow);
}
