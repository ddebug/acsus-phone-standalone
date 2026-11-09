/**
 * 聊天日记（按天总结）数据层
 * @module phone/messages/chat-diary-data
 *
 * @description
 * 把每天的聊天记录压缩成一段日记，后续聊天时用日记替换原始记录，
 * 以节省上下文。数据保存在独立手机文件里：
 *   phone.diaries[contactId] = { entries: [{ id, date, content, ... }] }
 *   phone.diarySettings = { enabled: true }
 */

import logger from '../../../logger.js';
import { extension_settings, saveSettingsDebounced, flushPhoneStorage } from '../../../standalone/phone-settings.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 本地日期键（YYYY-MM-DD），与界面显示/总结口径一致。 */
export function getLocalDateKey(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ensureDiaryData() {
  if (!extension_settings.acsusStandalonePhone.phone) {
    extension_settings.acsusStandalonePhone.phone = {};
  }
  const phone = extension_settings.acsusStandalonePhone.phone;
  if (!phone.diaries || typeof phone.diaries !== 'object') phone.diaries = {};
  if (!phone.diarySettings || typeof phone.diarySettings !== 'object') {
    phone.diarySettings = { enabled: true };
  }
  return phone;
}

async function persist() {
  try {
    await flushPhoneStorage();
  } catch (error) {
    logger.error('phone', '[ChatDiaryData] 日记保存失败:', error);
  }
}

/** 日记功能是否启用（启用后用日记替换原始历史记录）。 */
export function isDiaryEnabled() {
  const phone = ensureDiaryData();
  return phone.diarySettings.enabled !== false;
}

export async function setDiaryEnabled(enabled) {
  const phone = ensureDiaryData();
  phone.diarySettings.enabled = Boolean(enabled);
  saveSettingsDebounced();
  await persist();
}

/** 读取某个联系人的全部日记（按日期升序）。 */
export function loadDiaryEntries(contactId) {
  const phone = ensureDiaryData();
  const store = phone.diaries[contactId];
  const entries = Array.isArray(store?.entries) ? store.entries : [];
  return entries
    .filter(entry => entry && DATE_PATTERN.test(String(entry.date || '')))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** 日期 → 日记条目 的映射，供上下文构建快速查找。 */
export function getDiaryMap(contactId) {
  const map = new Map();
  for (const entry of loadDiaryEntries(contactId)) map.set(entry.date, entry);
  return map;
}

/**
 * 写入/覆盖某一天的日记。
 *
 * @param {string} contactId - 联系人ID
 * @param {Object} entry - { date, content, fromTime, toTime, messageCount }
 * @returns {Promise<Object>} 保存后的条目
 */
export async function upsertDiaryEntry(contactId, entry) {
  if (!entry || !DATE_PATTERN.test(String(entry.date || ''))) {
    throw new Error('日记日期格式应为 YYYY-MM-DD');
  }
  const content = String(entry.content || '').trim();
  if (!content) throw new Error('日记内容为空，未保存');

  const phone = ensureDiaryData();
  if (!phone.diaries[contactId] || typeof phone.diaries[contactId] !== 'object') {
    phone.diaries[contactId] = { entries: [] };
  }
  const store = phone.diaries[contactId];
  if (!Array.isArray(store.entries)) store.entries = [];

  const now = Date.now();
  const existingIndex = store.entries.findIndex(item => item.date === entry.date);
  const saved = {
    id: existingIndex >= 0 ? store.entries[existingIndex].id : `diary_${entry.date}_${now}`,
    date: entry.date,
    content,
    fromTime: Number.isFinite(Number(entry.fromTime)) ? Number(entry.fromTime) : null,
    toTime: Number.isFinite(Number(entry.toTime)) ? Number(entry.toTime) : null,
    messageCount: Number.isFinite(Number(entry.messageCount)) ? Number(entry.messageCount) : null,
    createdAt: existingIndex >= 0 ? (store.entries[existingIndex].createdAt || now) : now,
    updatedAt: now,
  };

  if (existingIndex >= 0) store.entries[existingIndex] = saved;
  else store.entries.push(saved);
  store.entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  saveSettingsDebounced();
  await persist();
  logger.info('phone', '[ChatDiaryData] 日记已保存:', contactId, entry.date, `${content.length}字`);
  return saved;
}

/** 删除某一天的日记。 */
export async function removeDiaryEntry(contactId, date) {
  const phone = ensureDiaryData();
  const store = phone.diaries[contactId];
  if (!store || !Array.isArray(store.entries)) return false;
  const before = store.entries.length;
  store.entries = store.entries.filter(entry => entry.date !== date);
  if (store.entries.length === before) return false;
  saveSettingsDebounced();
  await persist();
  return true;
}

/**
 * 按日期分组聊天记录，用于生成日记。
 *
 * @param {Array<Object>} messages - 聊天消息数组（已按时间排序）
 * @returns {Map<string, Array<Object>>} 日期 → 消息数组
 */
export function groupMessagesByDate(messages) {
  const groups = new Map();
  for (const message of messages) {
    const key = getLocalDateKey(message?.time);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  return groups;
}
