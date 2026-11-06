/**
 * 引用消息渲染器
 * @module phone/messages/message-types/quote-message
 */

import logger from '../../../../logger.js';
import { getThumbnailUrl } from '/script.js';

/**
 * 渲染引用消息气泡
 * 
 * @param {Object} message - 引用消息对象
 * @param {string} message.id - 消息ID
 * @param {string} message.sender - 发送者（'user' | 'contact'）
 * @param {string} message.type - 消息类型（固定为'quote'）
 * @param {number} message.time - 消息时间戳
 * @param {Object} message.quotedMessage - 被引用的消息
 * @param {string} message.quotedMessage.id - 原消息ID（用于跳转）
 * @param {string} message.quotedMessage.sender - 原发送者
 * @param {string} message.quotedMessage.senderName - 原发送者名字
 * @param {number} message.quotedMessage.time - 原消息时间
 * @param {string} message.quotedMessage.type - 原消息类型（text/emoji/image）
 * @param {string} [message.quotedMessage.content] - 原消息内容（文字/表情）
 * @param {string} [message.quotedMessage.imageUrl] - 原消息图片URL（type=image时）
 * @param {string} [message.quotedMessage.description] - 原消息图片描述（type=image时）
 * @param {string} message.replyContent - 回复内容
 * @param {Object} contact - 联系人对象
 * @param {string} contactId - 联系人ID
 * @returns {HTMLElement} 引用消息容器
 */
export function renderQuoteMessage(message, contact, contactId) {
  const container = document.createElement('div');
  container.className = 'chat-msg';
  container.dataset.msgId = message.id; // 用于跳转定位

  // 判断是发送还是接收
  const isSent = message.sender === 'user';
  container.classList.add(isSent ? 'chat-msg-sent' : 'chat-msg-received');

  // 创建头像
  const avatar = document.createElement('img');
  avatar.className = 'chat-msg-avatar';

  if (isSent) {
    // 用户头像
    const userAvatar = /** @type {HTMLImageElement} */ (document.querySelector('#phone-user-avatar'));
    avatar.src = userAvatar?.src || 'img/default-user.png';
  } else {
    // 联系人头像
    avatar.src = getThumbnailUrl('avatar', contact?.avatar) || 'img/default-avatar.png';
  }

  // 创建引用气泡
  const bubble = createQuoteBubble(message, contactId);

  // 组装（头像在前，气泡在后）
  container.appendChild(avatar);
  container.appendChild(bubble);

  // 长按操作菜单由 message-chat-ui.js 统一绑定

  return container;
}

/**
 * 创建引用气泡
 * 
 * @private
 * @param {Object} message - 引用消息对象
 * @param {string} contactId - 联系人ID
 * @returns {HTMLElement} 引用气泡元素
 */
function createQuoteBubble(message, contactId) {
  const bubble = document.createElement('div');
  bubble.className = 'chat-msg-bubble chat-msg-bubble-quote';

  // 引用框
  const quoteBox = document.createElement('div');
  quoteBox.className = 'chat-quote-box';

  // 引用框头部（发送者名字 + 时间 + 跳转按钮）
  const quoteHeader = document.createElement('div');
  quoteHeader.className = 'chat-quote-header';

  const senderName = document.createElement('span');
  senderName.className = 'chat-quote-sender';
  senderName.textContent = message.quotedMessage.senderName;

  const jumpBtn = document.createElement('button');
  jumpBtn.className = 'chat-quote-jump';
  jumpBtn.dataset.msgId = message.quotedMessage.id;
  jumpBtn.title = '跳转到原消息';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'chat-quote-time';
  timeSpan.textContent = formatMessageTime(message.quotedMessage.time);

  const arrowIcon = document.createElement('i');
  arrowIcon.className = 'fa-solid fa-arrow-up';

  jumpBtn.appendChild(timeSpan);
  jumpBtn.appendChild(arrowIcon);

  // 绑定跳转事件
  jumpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    logger.info('phone','🔘 [QuoteMessage] 点击了跳转按钮');
    logger.info('phone','[QuoteMessage] 跳转目标 - 消息ID:', message.quotedMessage.id, '联系人ID:', contactId);
    handleQuoteJump(message.quotedMessage.id, contactId);
  });

  quoteHeader.appendChild(senderName);
  quoteHeader.appendChild(jumpBtn);
  quoteBox.appendChild(quoteHeader);

  // 引用内容（根据类型渲染）
  const quoteContent = createQuoteContent(message.quotedMessage);
  quoteBox.appendChild(quoteContent);

  // 回复内容
  const replyBox = document.createElement('div');
  replyBox.className = 'chat-quote-reply';
  replyBox.textContent = message.replyContent;

  bubble.appendChild(quoteBox);
  bubble.appendChild(replyBox);

  return bubble;
}

/**
 * 创建引用内容（根据消息类型）
 * 
 * @private
 * @param {Object} quotedMessage - 被引用的消息
 * @returns {HTMLElement} 引用内容元素
 */
function createQuoteContent(quotedMessage) {
  const { type, content, imageUrl, description } = quotedMessage;

  if (type === 'image' && imageUrl) {
    // 图片引用：显示缩略图
    const img = document.createElement('img');
    img.className = 'chat-quote-img';
    img.src = imageUrl;
    img.alt = description || '图片';
    return img;
  } else {
    // 文字/表情引用：显示文本（最多2行）
    const text = document.createElement('div');
    text.className = 'chat-quote-text';
    text.textContent = formatQuoteText(quotedMessage);
    return text;
  }
}

/**
 * 格式化引用文本
 * 
 * @private
 * @param {Object} quotedMessage - 被引用的消息
 * @returns {string} 格式化后的文本
 */
function formatQuoteText(quotedMessage) {
  const { type, content, description, replyContent } = quotedMessage;

  switch (type) {
    case 'text':
      return content || '[空文本]';

    case 'emoji':
      return `[表情]${content || '未知'}`;

    case 'image':
      return `[图片]${description || '无描述'}`;

    case 'quote':
      // 引用的引用：只引用回复部分，不嵌套
      return replyContent || '[空回复]';

    default:
      return '[不支持的消息类型]';
  }
}

/**
 * 格式化消息时间（智能显示）
 * 
 * @private
 * @param {number} timestamp - 时间戳（秒）
 * @returns {string} 格式化后的时间
 */
function formatMessageTime(timestamp) {
  const date = new Date(timestamp * 1000);
  const now = new Date();

  // 今天：显示时间
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  // 昨天
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return '昨天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  // 今年：显示月日
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  }

  // 其他：显示年月日
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * 处理跳转到原消息
 * 
 * @private
 * @param {string} msgId - 原消息ID
 * @param {string} contactId - 联系人ID
 */
function handleQuoteJump(msgId, contactId) {
  logger.info('phone','🔍 [QuoteJump] ===== 开始跳转诊断 =====');
  logger.info('phone','[QuoteJump] 目标消息ID:', msgId);
  logger.info('phone','[QuoteJump] 联系人ID:', contactId);

  // 1️⃣ 查找所有带 data-contact-id 的元素（诊断：看看有哪些元素）
  const allElementsWithContactId = document.querySelectorAll(`[data-contact-id="${contactId}"]`);
  logger.info('phone','[QuoteJump] 找到', allElementsWithContactId.length, '个带 data-contact-id 的元素:');
  allElementsWithContactId.forEach((el, index) => {
    logger.info('phone',`  [${index}] 类名: ${el.className} | 标签: ${el.tagName} | ID: ${el.id || '无'}`);
  });

  // 2️⃣ 尝试查找聊天页面容器（使用精确选择器）
  let chatPage = document.querySelector(`.phone-chat-page[data-contact-id="${contactId}"]`);

  // 🔍 诊断：如果精确选择器没找到，尝试旧选择器看看找到了什么
  if (!chatPage) {
    logger.warn('phone','[QuoteJump] ⚠️ 精确选择器未找到页面，尝试旧选择器诊断...');
    const fallbackElement = document.querySelector(`[data-contact-id="${contactId}"]`);
    if (fallbackElement) {
      logger.info('phone','[QuoteJump] 旧选择器找到的元素:', {
        类名: fallbackElement.className,
        标签: fallbackElement.tagName,
        ID: fallbackElement.id || '无',
        是否是页面容器: fallbackElement.classList.contains('phone-page')
      });
    }
    logger.error('phone','[QuoteJump] ❌ 找不到聊天页面容器');
    logger.error('phone','[QuoteJump] 可能原因：页面未创建或contactId不匹配');
    return;
  }

  logger.info('phone','[QuoteJump] ✅ 找到聊天页面:', {
    类名: chatPage.className,
    标签: chatPage.tagName,
    ID: chatPage.id || '无',
    是否是页面容器: chatPage.classList.contains('phone-page')
  });

  // 3️⃣ 查看这个元素内的所有消息（诊断：看看消息是否在正确的容器里）
  const allMessages = chatPage.querySelectorAll('[data-msg-id]');
  logger.info('phone','[QuoteJump] 聊天页面内有', allMessages.length, '条消息');

  // 4️⃣ 尝试查找目标消息
  const targetMsg = chatPage.querySelector(`[data-msg-id="${msgId}"]`);

  if (!targetMsg) {
    logger.warn('phone','[QuoteJump] ❌ 找不到目标消息:', msgId);
    logger.info('phone','[QuoteJump] 所有消息ID列表:');
    allMessages.forEach((msg, index) => {
      logger.info('phone',`  [${index}] ID: ${msg.dataset.msgId} | 类名: ${msg.className}`);
    });

    // 显示提示
    const toast = document.createElement('div');
    toast.className = 'phone-toast phone-toast-info';
    toast.textContent = '原消息已被删除';
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2000);

    logger.info('phone','🔍 [QuoteJump] ===== 跳转失败（消息不存在）=====');
    return;
  }

  logger.info('phone','[QuoteJump] ✅ 找到目标消息:', {
    类名: targetMsg.className,
    父容器: targetMsg.parentElement?.className,
    位置: targetMsg.getBoundingClientRect()
  });

  // 5️⃣ 检查加号面板状态（诊断）
  const plusPanel = chatPage.querySelector('.chat-plus-panel');
  const emojiPanel = chatPage.querySelector('.chat-emoji-panel');
  logger.info('phone','[QuoteJump] 滚动前面板状态:', {
    加号面板active: plusPanel?.classList.contains('active'),
    表情面板active: emojiPanel?.classList.contains('active'),
    页面panel_active: chatPage.classList.contains('panel-active')
  });

  // 执行滚动和高亮
  logger.info('phone','[QuoteJump] 开始滚动到目标消息...');
  targetMsg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // 🔍 滚动后立即检查面板状态
  setTimeout(() => {
    logger.info('phone','[QuoteJump] 滚动后面板状态:', {
      加号面板active: plusPanel?.classList.contains('active'),
      表情面板active: emojiPanel?.classList.contains('active'),
      页面panel_active: chatPage?.classList.contains('panel-active')
    });
  }, 100);

  // 高亮动画（1秒）
  targetMsg.classList.add('chat-msg-highlight');
  setTimeout(() => {
    targetMsg.classList.remove('chat-msg-highlight');
  }, 1000);

  logger.info('phone','🔍 [QuoteJump] ===== 跳转成功 =====');
}

