/** Shared synchronous phone-history selection and text formatting. No sidecar store is read. */
import { getDiaryMap, getLocalDateKey, isDiaryEnabled } from '../messages/chat-diary-data.js';
import { splitCharacterExtras } from '../messages/character-extras-data.js';

/** Strip reserved AI-only transport blocks, without reading or appending any extras sidecar. */
export function sanitizeAIHistoryContent(msg, content) {
  const text = String(content ?? '');
  return msg?.sender === 'contact' ? splitCharacterExtras(text).text : text;
}

const windowCount = (value, fallback) => {
  const count = Number(value ?? fallback);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : fallback;
};

/** Slice original eligible messages FIRST. Diaries only replace dates inside the history window. */
export function selectHistoryContext(allMessages, sendSettings = {}, contactId) {
  const validMessages = (Array.isArray(allMessages) ? allMessages : []).filter(msg => msg && !msg.excluded);
  const recentCount = windowCount(sendSettings.recentCount, 20);
  const historyCount = windowCount(sendSettings.historyCount, 99);
  const historyEnd = Math.max(0, validMessages.length - recentCount);
  const recentMessages = validMessages.slice(historyEnd);
  const historyMessages = validMessages.slice(Math.max(0, historyEnd - historyCount), historyEnd);
  const diaryMap = historyMessages.length && contactId && isDiaryEnabled()
    ? getDiaryMap(contactId, validMessages) : new Map();
  const latestDate = getLocalDateKey(validMessages[validMessages.length - 1]?.time);
  const historyRenderList = [];
  const replacedDates = new Set();
  for (const msg of historyMessages) {
    const date = getLocalDateKey(msg.time);
    const entry = date && date !== latestDate ? diaryMap.get(date) : null;
    if (entry && typeof entry.content === 'string' && entry.content.trim()) {
      if (!replacedDates.has(date)) {
        historyRenderList.push({ __diary: true, date, time: msg.time, content: entry.content });
        replacedDates.add(date);
      }
    } else {
      historyRenderList.push(msg);
    }
  }
  return { validMessages, recentMessages, historyMessages, historyRenderList };
}

/** IDs are authoritative. Only two old no-ID messages may use the 30-second fallback. */
export function areSameApiCall(previous, current) {
  if (!previous || !current || previous.__diary || current.__diary ||
      previous.sender !== 'contact' || current.sender !== 'contact') return false;
  const date = getLocalDateKey(current.time);
  if (!date || date !== getLocalDateKey(previous.time)) return false;
  const normalizedId = value => value != null && String(value).trim() ? String(value) : null;
  // If both messages carry a secondary request ID, that boundary must agree as well.
  for (const key of ['apiCallId', 'proactiveRequestId']) {
    const left = normalizedId(previous[key]);
    const right = normalizedId(current[key]);
    if (left && right && left !== right) return false;
  }
  const callId = msg => normalizedId(msg.apiCallId) ? `api:${msg.apiCallId}`
    : normalizedId(msg.proactiveRequestId) ? `proactive:${msg.proactiveRequestId}` : null;
  const leftId = callId(previous);
  const rightId = callId(current);
  if (leftId || rightId) return Boolean(leftId && rightId && leftId === rightId);
  const leftTime = Number(previous.time);
  const rightTime = Number(current.time);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(rightTime - leftTime) <= 30;
}

/** First message and day changes include BOTH date and time; users always keep a header. */
export function formatHistoryTime(timestamp, prevTimestamp = null, isFirst = false) {
  const date = new Date(Number(timestamp) * 1000);
  const day = getLocalDateKey(timestamp);
  if (!day) return '[时间未知] ';
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return isFirst || prevTimestamp == null || day !== getLocalDateKey(prevTimestamp)
    ? `[${day} ${clock}] ` : `[${clock}] `;
}

export function buildCompactTimePrefix(list, index, msg) {
  const previous = index > 0 ? list[index - 1] : null;
  const multiline = item => item?.type === 'forwarded' || [item?.content, item?.replyContent, item?.description, item?.originalContent]
    .some(value => typeof value === 'string' && value.includes('\n'));
  if (!multiline(previous) && !multiline(msg) && areSameApiCall(previous, msg)) return '';
  return formatHistoryTime(msg.time, previous?.__diary ? null : previous?.time, !previous || previous.__diary);
}

/** Compatibility for builder text buffers. Only an explicitly headerless generated row can merge. */
export function compactSameCallLines(text) {
  if (typeof text !== 'string' || !text.includes(': ') || text.includes('[日记 ')) return text;
  const parseLine = line => {
    const match = line.match(/^(\[(?:\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?|\d{1,2}:\d{2}|时间未知)\] )?(.+?): (.*)$/);
    return match ? { hasTime: Boolean(match[1]), sender: match[2], content: match[3] } : null;
  };
  const output = [];
  let previous = null;
  for (const line of text.split('\n')) {
    const current = parseLine(line);
    if (current && !current.hasTime && previous && previous.sender === current.sender) {
      output[output.length - 1] += ` / ${current.content}`;
    } else {
      output.push(line);
    }
    previous = current;
  }
  return output.join('\n');
}

/** Compact contiguous text parts without crossing image/structured-part boundaries. */
export function compactHistoryTextParts(parts) {
  const output = [];
  let buffer = '';
  let previous = null;
  let mergeable = false;
  const flush = () => {
    if (buffer) output.push({ type: 'text', text: buffer });
    buffer = '';
  };
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string' && !part.thoughtSignature) {
      if (part.phoneMessage) {
        const msg = part.phoneMessage;
        const body = sanitizeAIHistoryContent(msg, part.phoneContent);
        const suffix = part.phoneNewline ? '\n' : '';
        if (mergeable && !body.includes('\n') && areSameApiCall(previous, msg)) {
          buffer = buffer.replace(/\n$/, '') + ` / ${body}${suffix}`;
        } else {
          buffer += `${formatHistoryTime(msg.time, previous?.time, !previous)}${part.phoneSender}: ${body}${suffix}`;
        }
        previous = msg;
        mergeable = !body.includes('\n');
      } else {
        buffer += part.text;
        if (part.text !== '\n') { previous = null; mergeable = false; }
      }
    } else {
      flush();
      output.push(part);
      previous = null;
      mergeable = false;
    }
  }
  flush();
  return output;
}

/** Known source: reference only. Out-of-window source: bounded preview, never the complete long original. */
export function formatQuoteReference(quotedMessage, sources = []) {
  if (!quotedMessage) return '[引用已删除消息]';
  const sourceId = quotedMessage.id || quotedMessage.messageId;
  const knownSource = sources instanceof Map
    ? sourceId && [...sources.values()].includes(sourceId)
    : Array.isArray(sources) && sources.some(msg => msg && !msg.__diary &&
      (sourceId ? msg.id === sourceId : msg.type === quotedMessage.type && msg.sender === quotedMessage.sender &&
        msg.time === quotedMessage.time && msg.content === quotedMessage.content));
  if (knownSource) return '[引用较早消息]';
  let text;
  switch (quotedMessage.type) {
    case 'emoji': text = `[表情]${quotedMessage.emojiName || ''}`; break;
    case 'image':
    case 'image-real':
    case 'image-fake': text = `[图片]${quotedMessage.description || ''}`; break;
    case 'quote': text = quotedMessage.replyContent; break;
    case 'recalled': text = '[已撤回消息]'; break;
    default: text = quotedMessage.content;
  }
  text = sanitizeAIHistoryContent(quotedMessage, text || '较早消息').replace(/\s+/g, ' ').trim() || '较早消息';
  return `[引用]${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
}

/** Text-only representation; API image attachment/metadata handling stays in the async builder. */
export function formatHistoryMessageContent(msg, options = {}) {
  return sanitizeAIHistoryContent(msg, formatHistoryMessageContentRaw(msg, options));
}

function formatHistoryMessageContentRaw(msg, { userName = '你', findEmojiById, sources = [] } = {}) {
  switch (msg.type) {
    case 'poke': return '[戳一戳]';
    case 'emoji': {
      const emoji = findEmojiById?.(msg.content);
      return emoji?.name || msg.emojiName ? `[表情]${emoji?.name || msg.emojiName}` : '[表情包已删除]';
    }
    case 'image-real': return msg.description ? `[图片]${msg.description}` : '[图片]';
    case 'image-fake': return `[图片]${msg.description || '无描述'}`;
    case 'image': return msg.imageUrl ? (msg.description ? `[图片]${msg.description}` : '[图片]') : `[图片]${msg.description || '无描述'}`;
    case 'quote': return `${formatQuoteReference(msg.quotedMessage, sources)}[回复]${msg.replyContent || ''}`;
    case 'redpacket': return `[红包]${msg.amount || '0'}元`;
    case 'video': return `[视频]${msg.description || ''}`;
    case 'file': return `[文件]${msg.filename || ''}${msg.size ? ` ${msg.size}` : ''}`;
    case 'plan': return `[约定计划]${msg.content || ''}`;
    case 'transfer': return `[转账]${msg.amount}元${msg.message ? ` ${msg.message}` : ''}`;
    case 'gift-membership': return `[送会员]${msg.months}个月${msg.membershipType === 'vip' ? 'VIP' : 'SVIP'}会员`;
    case 'buy-membership': return `[开会员]${msg.months}个月${msg.membershipType === 'vip' ? 'VIP' : 'SVIP'}会员`;
    case 'recalled': return msg.sender === 'user' ? `【${userName}撤回了一条消息】` : `[撤回]${msg.originalContent || '(无内容)'}`;
    case 'forwarded': {
      const contactName = msg.originalContactName || '未知联系人';
      const title = `${userName}与${contactName}的聊天记录`;
      if (!Array.isArray(msg.messages) || !msg.messages.length) return '[转发消息]\n[空聊天记录]\n[/空聊天记录]\n[/转发消息]';
      const body = msg.messages.map((inner, index) => {
        const sender = inner.senderName === '{{user}}' ? userName : inner.senderName || contactName;
        let content;
        switch (inner.type) {
          case 'redpacket': content = `[红包]${inner.amount || '0'}元`; break;
          case 'video': content = `[视频]${inner.description || ''}`; break;
          case 'file': content = `[文件]${inner.filename || ''}`; break;
          default: content = inner.type === 'forwarded' ? '[转发聊天记录]' : formatHistoryMessageContent(inner, { userName, findEmojiById, sources: msg.messages });
        }
        return `${formatHistoryTime(inner.time, index ? msg.messages[index - 1].time : null, index === 0)}${sender}: ${content}`;
      }).join('\n');
      return `[转发消息]\n[${title}]\n${body}\n[/${title}]\n[/转发消息]`;
    }
    default: return msg.content || '';
  }
}

/** Metadata-based grouping: diary and multiline paragraphs are opaque, never parsed as chat rows. */
export function formatCompactHistory(messages, { userName = '你', contactName = '角色', formatContent, onMessage } = {}) {
  const output = [];
  let previous = null;
  let mergeable = false;
  for (const msg of messages) {
    if (msg.__diary) {
      output.push(`[日记 ${msg.date}]\n${msg.content}\n`);
      previous = null;
      mergeable = false;
      continue;
    }
    const sender = msg.sender === 'user' ? userName : contactName;
    const content = sanitizeAIHistoryContent(msg, formatContent ? formatContent(msg) : formatHistoryMessageContent(msg, { userName, sources: messages }));
    onMessage?.(msg);
    if (mergeable && !content.includes('\n') && areSameApiCall(previous, msg)) {
      output[output.length - 1] += ` / ${content}`;
    } else {
      output.push(`${formatHistoryTime(msg.time, previous?.time, !previous)}${sender}: ${content}`);
    }
    previous = msg;
    mergeable = !content.includes('\n');
  }
  return output.join('\n');
}
