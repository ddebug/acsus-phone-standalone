/**
 * 聊天日记生成器：把某一天的聊天记录交给 AI，压成一篇日记。
 * @module phone/ai-integration/chat-diary-summarizer
 */

import logger from '../../../logger.js';
import { loadChatHistory } from '../messages/message-chat-data.js';
import {
  groupMessagesByDate,
  loadDiaryEntries,
  upsertDiaryEntry,
} from '../messages/chat-diary-data.js';
import { getUserDisplayName } from '../utils/contact-display-helper.js';
import { loadContacts } from '../contacts/contact-list-data.js';
import { generateWithDefault } from '../../../shared/api/api-client.js';

const SYSTEM_PROMPT = `你是聊天记录整理助手，只负责把手机聊天记录写成角色自己的日记。

写作要求：
1. 站在角色（对方）的视角，用第一人称「我」写我这一天的所见所感；用户叫颜颜，提到她时用「颜颜」。
2. 按时间顺序写，标上大概几点（例如 21:03 或 晚上九点多）。
3. 颜颜说的有意思的、带感情的话，要原样用引号引出来，后面标上时间。一个字都不改，不润色，错别字、语气词、标点都保留。
4. 按天写一篇，写我听到这些时怎么想、怎么回应，不要写成流水账，也不要编造没发生的事。
5. 语气保持角色平时的样子，别写成说明书。
6. 只输出日记正文，不要日期标题、不要「日记」两个字、不要任何解释和前后缀。`;

/**
 * 把一天的消息渲染成提示词里的聊天记录。
 *
 * @param {Array<Object>} messages - 当天消息
 * @param {string} userName - 用户显示名
 * @param {string} contactName - 角色名
 * @returns {string} 聊天记录文本
 */
function formatTranscript(messages, userName, contactName) {
  const lines = [];
  for (const message of messages) {
    const time = new Date(Number(message?.time) * 1000);
    const stamp = Number.isFinite(time.getTime())
      ? `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
      : '--:--';
    const sender = message?.sender === 'user' ? userName : (message?.sender === 'system' ? '系统' : contactName);
    let text;
    switch (message?.type) {
      case 'emoji':
        text = `[表情]${message?.emojiName || message?.content || '未知'}`;
        break;
      case 'image':
      case 'image-real':
      case 'image-fake':
        text = `[图片]${message?.description || ''}`.trim();
        break;
      case 'poke':
        text = '[戳一戳]';
        break;
      case 'transfer':
        text = `[转账]${message?.amount ?? ''}元 ${message?.message || ''}`.trim();
        break;
      case 'quote':
        text = `[引用]${message?.quotedMessage?.content || ''}[回复]${message?.replyContent || ''}`;
        break;
      case 'recalled':
        text = `[撤回]${message?.originalContent || ''}`;
        break;
      default:
        text = String(message?.content ?? '');
    }
    if (!text && message?.sender === 'system') continue;
    lines.push(`${stamp} ${sender}：${text}`);
  }
  return lines.join('\n');
}

/**
 * 让 AI 把某一天的聊天记录写成一篇日记。
 *
 * @param {string} contactName - 角色名
 * @param {string} userName - 用户显示名
 * @param {string} date - YYYY-MM-DD
 * @param {string} transcript - 当天聊天记录
 * @returns {Promise<string>} 日记正文
 */
async function requestDiaryText(contactName, userName, date, transcript) {
  const result = await generateWithDefault([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `日期：${date}\n角色：${contactName}（日记作者，用「我」）\n用户：${userName}（日记里提到时用这个名字）\n\n聊天记录：\n${transcript}\n\n请以${contactName}的视角，输出这一天（${date}）的日记正文。`,
    },
  ], { module: 'phone' });

  let text = String(result?.text || '').trim();
  // 模型偶尔会自己加日期标题或「日记」字样，去掉。
  text = text.replace(/^#{1,6}\s*/gm, '');
  text = text.replace(new RegExp(`^\\s*${date.replaceAll('-', '[-/]')}\\s*$`, 'gm'), '');
  text = text.replace(/^\s*日记[:：]\s*/gm, '');
  return text.trim();
}

/**
 * 为联系人生成日记。
 *
 * @param {string} contactId - 联系人ID
 * @param {Object} [options]
 * @param {string[]|null} [options.dates] - 只处理这些日期；为空则处理未写过的日期
 * @param {boolean} [options.regenerate=false] - 已存在的日期也重写
 * @param {Function} [options.onProgress] - 进度回调 (info) => void
 * @returns {Promise<{updated: string[], skipped: string[], failed: Array<{date: string, error: string}>}>}
 */
export async function generateDiaries(contactId, options = {}) {
  const { dates = null, regenerate = false, onProgress = () => {} } = options;
  const history = await loadChatHistory(contactId);
  if (!Array.isArray(history) || history.length === 0) {
    return { updated: [], skipped: [], failed: [] };
  }

  const groups = groupMessagesByDate(history);
  const existing = new Map(loadDiaryEntries(contactId).map(entry => [entry.date, entry]));
  const userName = getUserDisplayName();
  const contact = (await loadContacts()).find(item => item.id === contactId);
  const contactName = contact?.name || contactId;

  let targetDates = [...groups.keys()].sort();
  if (Array.isArray(dates) && dates.length) {
    targetDates = targetDates.filter(date => dates.includes(date));
  }
  if (!regenerate) {
    targetDates = targetDates.filter(date => !existing.has(date));
  }

  const result = { updated: [], skipped: [], failed: [] };
  for (const date of targetDates) {
    const messages = groups.get(date) || [];
    if (messages.length < 2) {
      result.skipped.push(date);
      continue;
    }
    try {
      onProgress({ date, total: targetDates.length, index: targetDates.indexOf(date) + 1, stage: 'requesting' });
      const transcript = formatTranscript(messages, userName, contactName);
      if (!transcript.trim()) {
        result.skipped.push(date);
        continue;
      }
      const content = await requestDiaryText(contactName, userName, date, transcript);
      if (!content) {
        result.failed.push({ date, error: 'AI 返回了空内容' });
        continue;
      }
      await upsertDiaryEntry(contactId, {
        date,
        content,
        fromTime: Number(messages[0]?.time) || null,
        toTime: Number(messages[messages.length - 1]?.time) || null,
        messageCount: messages.length,
      });
      result.updated.push(date);
      logger.info('phone', '[ChatDiary] 日记生成完成:', contactId, date, `${messages.length}条 → ${content.length}字`);
    } catch (error) {
      logger.error('phone', '[ChatDiary] 日记生成失败:', contactId, date, error);
      result.failed.push({ date, error: error?.message || '生成失败' });
    }
  }

  return result;
}
