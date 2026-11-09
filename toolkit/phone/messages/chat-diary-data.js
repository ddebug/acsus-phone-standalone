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
export const DIARY_SKIP_THRESHOLD = 20;

/** 可编辑的是写作要求；批量分日保存所需的 JSON 协议由生成器单独追加。 */
export const DEFAULT_DIARY_PROMPT = `站在角色自己的视角写日记，第一人称“我”指日记作者，而不是用户。
根据角色资料和完整聊天历史保持角色的身份、语气及与用户的关系。
按指定日期分别写，每篇按时间顺序，标出大概几点。适度压缩重要事件、互动、感受和关系变化，不要逐句复述。
不强制保留用户原话；确有必要时可择要引用，但引用必须与原文一致，不伪造原话。
只记录聊天中能确认的事情。隔天转述的旧事要说明是当日回顾；不编造线下行动、关系或动机，不把猜测当成事实。
保持角色平时的语感，不要写成说明书。`;

export function getDiaryPrompt() {
  const prompt = ensureDiaryData().diarySettings.prompt;
  return typeof prompt === 'string' && prompt.trim() ? prompt : DEFAULT_DIARY_PROMPT;
}

/** 全手机共用，随独立数据备份；保存失败恢复旧值并向 UI 报错。 */
export async function setDiaryPrompt(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('总结提示词不能为空');
  const settings = ensureDiaryData().diarySettings;
  const previous = settings.prompt;
  settings.prompt = text;
  try {
    saveSettingsDebounced();
    await persist();
  } catch (error) {
    if (previous === undefined) delete settings.prompt;
    else settings.prompt = previous;
    throw error;
  }
}

/** 非安全用途的源记录指纹，用于发现日记生成后的增删改。 */
export function getDiarySourceFingerprint(messages) {
  // 持久层会排序对象键；键顺序不属于消息内容，否则刷新会误判日记过期。
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
  };
  const text = JSON.stringify(canonical(messages));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
}

/** UI 与生成器共用判定：20条及以下跳过，旧日记源记录变更后重新待总结。 */
export function getDiaryDayStatuses(messages, entries) {
  const existing = new Map(entries.map(entry => [entry.date, entry]));
  return [...groupMessagesByDate(messages.filter(message => !message.excluded))]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, dayMessages]) => {
      const entry = existing.get(date);
      // 旧版本没有正文指纹，仅条数/末条时间无法证明正文没被编辑。
      const sameSource = Boolean(entry?.sourceFingerprint) &&
        entry.sourceFingerprint === getDiarySourceFingerprint(dayMessages);
      return {
        date,
        messageCount: dayMessages.length,
        status: dayMessages.length <= DIARY_SKIP_THRESHOLD ? 'skipped' : sameSource ? 'summarized' : 'pending',
      };
    });
}

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
    throw error;
  }
}

/** 日记功能是否启用（启用后用日记替换原始历史记录）。 */
export function isDiaryEnabled() {
  const phone = ensureDiaryData();
  return phone.diarySettings.enabled !== false;
}

export async function setDiaryEnabled(enabled) {
  const phone = ensureDiaryData();
  const previous = phone.diarySettings.enabled;
  phone.diarySettings.enabled = Boolean(enabled);
  try {
    saveSettingsDebounced();
    await persist();
  } catch (error) {
    phone.diarySettings.enabled = previous;
    throw error;
  }
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
export function getDiaryMap(contactId, messages = null) {
  const entries = loadDiaryEntries(contactId);
  const validDates = messages ? new Set(getDiaryDayStatuses(messages, entries)
    .filter(day => day.status === 'summarized').map(day => day.date)) : null;
  return new Map(entries.filter(entry => !validDates || validDates.has(entry.date)).map(entry => [entry.date, entry]));
}

/**
 * 写入/覆盖某一天的日记。
 *
 * @param {string} contactId - 联系人ID
 * @param {Object} entry - { date, content, fromTime, toTime, messageCount }
 * @returns {Promise<Object>} 保存后的条目
 */
export async function upsertDiaryEntry(contactId, entry) {
  return (await saveDiaryEntries(contactId, [entry]))[0];
}

/** 一次提交本轮所有日期；验证失败不动旧日记，写盘失败不声称已保存。 */
export async function saveDiaryEntries(contactId, entries) {
  const phone = ensureDiaryData();
  const previous = phone.diaries[contactId];
  const merged = new Map(loadDiaryEntries(contactId).map(entry => [entry.date, entry]));
  const now = Date.now();
  const dates = new Set();
  const saved = entries.map(entry => {
    if (!entry || !DATE_PATTERN.test(String(entry.date || '')) || dates.has(entry.date)) {
      throw new Error('日记日期无效或重复，未保存');
    }
    dates.add(entry.date);
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (!content) throw new Error('日记内容为空，未保存');
    const old = merged.get(entry.date);
    return {
      id: old?.id || `diary_${entry.date}_${now}`,
      date: entry.date, content,
      fromTime: Number.isFinite(Number(entry.fromTime)) ? Number(entry.fromTime) : null,
      toTime: Number.isFinite(Number(entry.toTime)) ? Number(entry.toTime) : null,
      messageCount: Number.isFinite(Number(entry.messageCount)) ? Number(entry.messageCount) : null,
      sourceFingerprint: entry.sourceFingerprint || '',
      createdAt: old?.createdAt || now,
      updatedAt: now,
    };
  });
  if (!saved.length) return [];
  for (const entry of saved) merged.set(entry.date, entry);
  phone.diaries[contactId] = {
    ...previous,
    entries: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
  try {
    saveSettingsDebounced();
    await persist();
  } catch (error) {
    // 不自动重试结果不明确的写入；恢复运行时旧日记，避免错误隐藏原文。
    if (previous) phone.diaries[contactId] = previous;
    else delete phone.diaries[contactId];
    throw error;
  }
  return saved;
}

/** 删除某一天的日记。 */
export async function removeDiaryEntry(contactId, date) {
  const phone = ensureDiaryData();
  const store = phone.diaries[contactId];
  if (!store || !Array.isArray(store.entries)) return false;
  const previous = store.entries;
  const remaining = previous.filter(entry => entry.date !== date);
  if (remaining.length === previous.length) return false;
  store.entries = remaining;
  try {
    saveSettingsDebounced();
    await persist();
  } catch (error) {
    store.entries = previous;
    throw error;
  }
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
