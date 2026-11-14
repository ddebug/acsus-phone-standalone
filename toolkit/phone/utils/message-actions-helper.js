/**New Cascade
 * 消息操作菜单助手
 * @module phone/utils/message-actions-helper
 * 
 * @description
 * 处理消息气泡的操作菜单（删除、转发、收藏等）
 * 类似QQ长按消息后的操作菜单
 */

import logger from '../../../logger.js';
import { loadChatHistory, saveChatHistory, updateMessage } from '../messages/message-chat-data.js';
import { updateContactItem } from '../messages/message-list-ui.js';
import { getContactDisplayName } from './contact-display-helper.js';
import { enterMultiSelectMode } from '../messages/message-multiselect-ui.js';

/**
 * 生成唯一消息ID
 * 
 * @returns {string} 唯一ID（格式：msg_时间戳_随机字符串）
 * 
 * @example
 * const id = generateMessageId();
 * // 返回：'msg_1761669817123_a8f3d9x2q'
 */
export function generateMessageId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 9);
  return `msg_${timestamp}_${random}`;
}

// 当前显示的操作菜单（单例）
let currentMenu = null;

// 长按定时器（全局单例）
let longPressTimer = null;
let isDragging = false;
let touchStartPos = { x: 0, y: 0 };

// 🔑 触发菜单的气泡元素（用于防止触发源的点击关闭菜单）
let triggerElement = null;

/**
 * 显示消息操作菜单
 * 
 * @param {HTMLElement} messageElement - 消息气泡元素
 * @param {Object} message - 消息对象
 * @param {string} message.sender - 发送者（'user' | 'contact'）
 * @param {number} message.time - 时间戳（用于删除定位）
 * @param {string} contactId - 联系人ID
 * @param {Object} [options] - 配置选项
 * @param {boolean} [options.disableQuote] - 禁用引用功能
 * 
 * @example
 * bubble.addEventListener('click', (e) => {
 *   showMessageActions(container, message, contactId, { disableQuote: true });
 * });
 */
export function showMessageActions(messageElement, message, contactId, options = {}) {
  // 如果已有菜单，先关闭
  if (currentMenu) {
    closeMessageActions();
  }

  const menu = createActionsMenu(message, contactId, messageElement, options);
  document.body.appendChild(menu);
  currentMenu = menu;
  triggerElement = messageElement; // 🔑 记录触发源

  // 计算位置（自适应上/下）
  positionMenu(menu, messageElement);

  // 点击空白处关闭（延迟500ms，避免捕获松手的click事件）
  // ✅ 从300ms增加到500ms，给PC端和移动端足够的事件处理缓冲时间
  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick);
    triggerElement = null; // 清除触发源标记（500ms后允许气泡点击关闭菜单）
  }, 500);

  logger.debug('phone','[MessageActions] 显示操作菜单', options.disableQuote ? '（禁用引用）' : '');
}

/**
 * 绑定长按触发逻辑到消息气泡
 * 
 * @param {HTMLElement} bubbleElement - 消息气泡元素
 * @param {Object} message - 消息对象
 * @param {string} contactId - 联系人ID
 * @param {Object} [options] - 配置选项
 * @param {boolean} [options.disableQuote] - 禁用引用功能
 * 
 * @description
 * 支持PC端（鼠标）和移动端（触摸）长按
 * - PC端：鼠标按住500ms触发
 * - 移动端：触摸按住500ms触发
 * - 拖动超过10px取消长按
 * 
 * @example
 * const bubble = document.createElement('div');
 * bindLongPress(bubble, message, contactId, { disableQuote: true });
 */
export function bindLongPress(bubbleElement, message, contactId, options = {}) {
  // 🖱️ PC端：鼠标长按
  bubbleElement.addEventListener('mousedown', (e) => {
    // 只响应左键
    if (e.button !== 0) return;

    isDragging = false;
    touchStartPos = { x: e.clientX, y: e.clientY };

    longPressTimer = setTimeout(() => {
      if (!isDragging) {
        showMessageActions(bubbleElement, message, contactId, options);
      }
    }, 500);
  });

  bubbleElement.addEventListener('mousemove', (e) => {
    if (!longPressTimer) return;

    const deltaX = Math.abs(e.clientX - touchStartPos.x);
    const deltaY = Math.abs(e.clientY - touchStartPos.y);

    if (deltaX > 10 || deltaY > 10) {
      isDragging = true;
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  bubbleElement.addEventListener('mouseup', () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  });

  bubbleElement.addEventListener('mouseleave', () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  });

  // 📱 移动端：触摸长按
  bubbleElement.addEventListener('touchstart', (e) => {
    isDragging = false;
    const touch = e.touches[0];
    touchStartPos = { x: touch.clientX, y: touch.clientY };

    longPressTimer = setTimeout(() => {
      if (!isDragging) {
        showMessageActions(bubbleElement, message, contactId, options);
      }
    }, 500);
  });

  bubbleElement.addEventListener('touchmove', (e) => {
    if (!longPressTimer) return;

    const touch = e.touches[0];
    const deltaX = Math.abs(touch.clientX - touchStartPos.x);
    const deltaY = Math.abs(touch.clientY - touchStartPos.y);

    if (deltaX > 10 || deltaY > 10) {
      isDragging = true;
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  bubbleElement.addEventListener('touchend', () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  });

  bubbleElement.addEventListener('touchcancel', () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  });
}

/**
 * 关闭消息操作菜单
 */
export function closeMessageActions() {
  if (currentMenu) {
    currentMenu.remove();
    currentMenu = null;
    triggerElement = null; // 清除触发源标记
    document.removeEventListener('click', handleOutsideClick);
    logger.debug('phone','[MessageActions] 关闭操作菜单');
  }
}

/**
 * 创建操作菜单DOM
 * 
 * @private
 * @param {Object} message - 消息对象
 * @param {string} contactId - 联系人ID
 * @param {HTMLElement} messageElement - 消息气泡元素（用于删除）
 * @param {Object} [options] - 配置选项
 * @param {boolean} [options.disableQuote] - 禁用引用功能
 * @returns {HTMLElement} 菜单元素
 */
function createActionsMenu(message, contactId, messageElement, options = {}) {
  const menu = document.createElement('div');
  menu.className = 'chat-msg-actions-menu';

  // ✅ 箭头改用CSS伪元素，不再创建DOM节点（零内存开销）

  // 按钮容器（两行）
  const container = document.createElement('div');
  container.className = 'chat-msg-actions-container';

  // 第一行按钮
  const row1 = document.createElement('div');
  row1.className = 'chat-msg-actions-row';

  // 用户消息额外有"撤回"按钮
  if (message.sender === 'user') {
    row1.appendChild(createActionButton('undo', '撤回', () => {
      handleRecall(message, contactId, messageElement);
    }));
  }

  row1.appendChild(createActionButton('star', '收藏', async () => {
    await handleFavorite(message, contactId);
  }));
  row1.appendChild(createActionButton('trash', '删除', () => {
    handleDelete(message, contactId, messageElement);
  }));
  row1.appendChild(createActionButton('check-square', '多选', () => {
    handleMultiSelect(message);
  }));

  // 第二行按钮（引用功能）
  const row2 = document.createElement('div');
  row2.className = 'chat-msg-actions-row';

  // 只有未禁用引用功能时才添加引用按钮
  if (!options.disableQuote) {
    row2.appendChild(createActionButton('quote-left', '引用', () => {
      handleQuote(message, contactId);
    }));
  }

  container.appendChild(row1);
  // 只有第二行有按钮时才添加第二行
  if (row2.children.length > 0) {
    container.appendChild(row2);
  }
  menu.appendChild(container);

  return menu;
}

/**
 * 创建单个操作按钮
 * 
 * @private
 * @param {string} icon - Font Awesome 图标名（不含fa-前缀）
 * @param {string} label - 按钮文字
 * @param {Function} handler - 点击处理函数
 * @returns {HTMLElement} 按钮元素
 */
function createActionButton(icon, label, handler) {
  const button = document.createElement('button');
  button.className = 'chat-msg-action-btn';

  const iconEl = document.createElement('i');
  iconEl.className = `fa-solid fa-${icon}`;

  const labelEl = document.createElement('span');
  labelEl.textContent = label;

  button.appendChild(iconEl);
  button.appendChild(labelEl);

  button.addEventListener('click', (e) => {
    e.stopPropagation(); // 防止触发外部点击关闭
    handler();
  });

  return button;
}

/**
 * 计算并设置菜单位置
 * 
 * @private
 * @param {HTMLElement} menu - 菜单元素
 * @param {HTMLElement} messageElement - 消息气泡元素
 * 
 * @description
 * 优化后的定位逻辑：
 * 1. 智能上/下位置（根据屏幕空间）
 * 2. 动态箭头定位（CSS变量控制，精确指向气泡）
 * 3. 边界检测（防止超出聊天区域）
 * 4. 弹出动画起点设置（transform-origin）
 */
function positionMenu(menu, messageElement) {
  const rect = messageElement.getBoundingClientRect();
  const menuHeight = 120; // 菜单预估高度（缩小后）
  const menuWidth = 256; // 菜单宽度（16em）
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;

  // ✅ 优先显示在下方，空间不足则显示在上方
  const showBelow = spaceBelow >= menuHeight;

  if (showBelow) {
    menu.style.top = `${rect.bottom + 10}px`;
    menu.classList.add('show-below');
    menu.style.transformOrigin = 'top center'; // 🎯 从上边缘弹出
  } else {
    menu.style.top = `${rect.top - menuHeight - 10}px`;
    menu.classList.add('show-above');
    menu.style.transformOrigin = 'bottom center'; // 🎯 从下边缘弹出
  }

  // ✅ 水平居中对齐消息气泡
  const bubbleCenterX = rect.left + rect.width / 2;
  menu.style.left = `${bubbleCenterX - menuWidth / 2}px`;

  // ✅ 获取聊天区域边界（而非整个窗口）
  const chatContent = messageElement.closest('.chat-content');
  const chatRect = chatContent ? chatContent.getBoundingClientRect() : {
    left: 0,
    right: window.innerWidth
  };

  // ✅ 防止超出聊天区域左右边界
  const menuRect = menu.getBoundingClientRect();
  let finalLeft = parseFloat(menu.style.left);

  if (menuRect.left < chatRect.left + 10) {
    finalLeft = chatRect.left + 10;
    menu.style.left = `${finalLeft}px`;
  } else if (menuRect.right > chatRect.right - 10) {
    finalLeft = chatRect.right - menuWidth - 10;
    menu.style.left = `${finalLeft}px`;
  }

  // 🔥 动态计算箭头位置（精确指向气泡中心）
  const arrowOffset = bubbleCenterX - finalLeft;
  menu.style.setProperty('--arrow-offset', `${arrowOffset}px`);
}

/**
 * 处理点击外部区域
 * 
 * @private
 * @param {MouseEvent} e - 点击事件
 * 
 * @description
 * ✅ 优化：防止触发菜单的气泡点击关闭菜单
 * - 忽略菜单内部的点击
 * - 忽略触发源气泡的点击（在500ms缓冲期内）
 * - 点击其他区域关闭菜单
 */
function handleOutsideClick(e) {
  if (!currentMenu) return;

  // 🔑 点击菜单内部 → 不关闭
  if (currentMenu.contains(e.target)) return;

  // 🔑 点击触发源气泡 → 不关闭（防止松手的click事件关闭菜单）
  if (triggerElement && triggerElement.contains(e.target)) return;

  // ✅ 点击其他区域 → 关闭菜单
  closeMessageActions();
}

/**
 * 处理撤回消息
 * 
 * @private
 * @async
 * @param {Object} message - 消息对象
 * @param {string} contactId - 联系人ID
 * @param {HTMLElement} messageElement - 消息气泡元素
 * 
 * @description
 * 用户只能撤回2分钟内发送的消息
 * 撤回后：
 * - 消息变为 type: 'recalled'
 * - 保存原始内容（用户可偷看）
 * - UI替换为撤回提示气泡
 */
async function handleRecall(message, contactId, messageElement) {
  closeMessageActions();

  // 1. 检查是否是用户自己的消息
  if (message.sender !== 'user') {
    logger.warn('phone','[MessageActions] 只能撤回自己的消息');
    const { showToast } = await import('../ui-components/toast-notification.js');
    showToast('只能撤回自己的消息', 'warning');
    return;
  }

  // 2. 检查是否超过2分钟
  const now = Math.floor(Date.now() / 1000);
  const timeDiff = now - message.time;

  if (timeDiff > 120) {
    logger.warn('phone','[MessageActions] 消息超过2分钟无法撤回，时间差:', timeDiff, '秒');
    const { showToast } = await import('../ui-components/toast-notification.js');
    showToast('消息发送已超过2分钟，无法撤回', 'warning');
    return;
  }

  // 3. 获取原始内容（根据类型）
  let originalContent = '';
  switch (message.type) {
    case 'text':
      originalContent = message.content;
      break;
    case 'emoji':
      originalContent = message.emojiName || message.content;
      break;
    case 'image':
      originalContent = message.description || '[图片]';
      break;
    case 'quote':
      originalContent = message.replyContent || message.content;
      break;
    case 'transfer':
      originalContent = `[转账]¥${message.amount}`;
      break;
    default:
      originalContent = message.content || '[未知消息]';
  }

  // 4. 构建撤回消息对象
  const updatedMessage = {
    type: 'recalled',
    recalledTime: now,
    originalContent: originalContent,
    originalType: message.type,
    canPeek: true,  // 用户也可以偷看自己撤回的消息
    // 保留需要的字段（用于偷看时渲染）
    emojiName: message.emojiName,
    imageUrl: message.imageUrl,
    description: message.description,
    replyContent: message.replyContent,
    amount: message.amount,
    transferNote: message.transferNote
  };

  // 5. 更新存储
  const success = await updateMessage(contactId, message.id, updatedMessage);

  if (!success) {
    logger.error('phone','[MessageActions] 撤回失败，无法更新存储');
    const { showToast } = await import('../ui-components/toast-notification.js');
    showToast('撤回失败，请重试', 'error');
    return;
  }

  // 6. 重新渲染这条消息（替换DOM）
  const { renderRecalledMessage } = await import('../messages/message-types/recalled-message.js');
  const { loadContacts } = await import('../contacts/contact-list-data.js');

  const contacts = await loadContacts();
  const contact = contacts.find(c => c.id === contactId);

  const newBubble = renderRecalledMessage({
    ...message,
    ...updatedMessage
  }, contact, contactId);

  messageElement.replaceWith(newBubble);

  // 7. 更新消息列表（刷新最后一条消息预览）
  updateContactItem(contactId);

  logger.info('phone','[MessageActions] 撤回消息成功:', message.id);
  const { showToast } = await import('../ui-components/toast-notification.js');
  showToast('已撤回', 'success');
}

/**
 * 处理收藏消息
 * 
 * @private
 * @param {Object} message - 消息对象
 * @param {string} contactId - 联系人ID
 */
async function handleFavorite(message, contactId) {
  logger.info('phone','[MessageActions] 收藏消息:', message.content?.substring(0, 20), 'type:', message.type);
  logger.debug('phone','[MessageActions] 完整消息对象:', message);
  closeMessageActions();

  const { addFavorite, deleteFavoriteByMessageId, isFavorited } = await import('../favorites/favorites-data.js');
  const { loadContacts } = await import('../contacts/contact-list-data.js');
  const { showSuccessToast } = await import('../ui-components/toast-notification.js');

  // 检查是否已收藏
  if (isFavorited(message.id)) {
    // 取消收藏
    deleteFavoriteByMessageId(message.id);
    showSuccessToast('已取消收藏');
    logger.info('phone','[MessageActions] 已取消收藏:', message.id);
    return;
  }

  // 获取联系人信息
  const contacts = await loadContacts();
  const contact = contacts.find(c => c.id === contactId);

  if (!contact) {
    logger.warn('phone','[MessageActions] 找不到联系人:', contactId);
    return;
  }

  // 确定发送者信息（如果是联系人发的，用联系人信息；如果是用户发的，用"我"）
  let senderName = contact.remark || contact.name;
  let senderAvatar = contact.avatar;

  if (message.sender === 'user') {
    senderName = '我';
    senderAvatar = null; // 用户头像暂时不保存
  }

  // 构建收藏数据（保存完整的消息字段）
  const favoriteData = {
    messageId: message.id,
    contactId: contactId,
    contactName: senderName,
    contactAvatar: senderAvatar,
    type: message.type || 'text',
    content: message.content || '',
    originalTimestamp: message.time
  };

  // 根据消息类型保存额外字段
  if (message.type === 'emoji') {
    // 如果有emojiName直接使用，否则通过ID查找
    if (message.emojiName) {
      favoriteData.emojiName = message.emojiName;
    } else {
      // 旧数据兼容：通过ID查找表情包获取名称
      const { findEmojiById } = await import('../emojis/emoji-manager-data.js');
      const emoji = findEmojiById(message.content);
      favoriteData.emojiName = emoji ? emoji.name : message.content; // 找不到就用ID
    }
    logger.debug('phone','[MessageActions] emoji收藏，emojiName:', favoriteData.emojiName, 'content:', message.content);
  }

  if (message.type === 'image') {
    favoriteData.description = message.description || '';
    favoriteData.imageUrl = message.imageUrl || '';
    logger.debug('phone','[MessageActions] image收藏，description:', message.description, 'imageUrl:', message.imageUrl);
  }

  if (message.type === 'transfer') {
    favoriteData.amount = message.amount || 0;
    favoriteData.message = message.message || '';
    logger.debug('phone','[MessageActions] transfer收藏，amount:', message.amount, 'message:', message.message);
  }

  if (message.type === 'quote') {
    favoriteData.quotedMessage = message.quotedMessage;
    favoriteData.replyContent = message.replyContent || '';
    logger.debug('phone','[MessageActions] quote收藏，replyContent:', message.replyContent);
  }

  logger.debug('phone','[MessageActions] 最终收藏数据:', favoriteData);

  // 添加收藏
  addFavorite(favoriteData);

  showSuccessToast('已添加到收藏');
  logger.info('phone','[MessageActions] 已添加收藏:', message.id);
}

/**
 * 处理删除消息
 * 
 * @private
 * @param {Object} message - 消息对象
 * @param {string} contactId - 联系人ID
 * @param {HTMLElement} messageElement - 消息气泡元素
 * 
 * @description
 * 优先使用消息ID精确匹配删除，避免误删同时间戳的消息
 * 兼容旧数据：没有ID的消息使用时间戳+发送者+内容组合匹配
 */
async function handleDelete(message, contactId, messageElement) {
  try {
    // 1. 从数据库删除
    const chatHistory = await loadChatHistory(contactId);
    // 🔍 详细日志：删除前的数据和DOM状态
    const page = messageElement.closest('.phone-page');
    const chatContent = page?.querySelector('.chat-content');
    const beforeDomCount = chatContent?.querySelectorAll('.chat-msg').length || 0;
    const beforeDataCount = chatHistory.length;
    logger.info('phone','📊 [删除前] 数据:', beforeDataCount, '条，DOM:', beforeDomCount, '条，要删除ID:', message.id || '无');

    let newHistory;

    if (message.id) {
      // 新数据：使用ID精确匹配（推荐）
      newHistory = chatHistory.filter(msg => msg.id !== message.id);
      logger.debug('phone','[MessageActions] 使用ID删除:', message.id);
    } else {
      // 旧数据兼容：使用时间戳+发送者+内容组合匹配
      newHistory = chatHistory.filter(msg =>
        !(msg.time === message.time &&
          msg.sender === message.sender &&
          msg.content === message.content)
      );
      logger.debug('phone','[MessageActions] 使用组合匹配删除（旧数据）:', message.time);
    }

    await saveChatHistory(contactId, newHistory);

    // 🎯 删除对应的计划数据（如果是计划消息）
    if (message.content?.startsWith('[约定计划')) {
      try {
        const { getPlanByMessageId, deletePlan } = await import('../plans/plan-data.js');
        const plan = getPlanByMessageId(contactId, message.id);
        
        if (plan) {
          deletePlan(contactId, plan.id);
          logger.info('phone','[MessageActions] 已同步删除计划数据:', plan.title);
        } else {
          logger.debug('phone','[MessageActions] 该计划消息无对应计划数据');
        }
      } catch (error) {
        logger.warn('phone','[MessageActions] 删除计划数据失败（不影响消息删除）:', error);
      }
    }

    // 2. 从DOM移除（删除整个消息容器，不是只删除气泡）
    // messageElement 是气泡元素（.chat-msg-bubble），需要找到父容器（.chat-msg）
    const messageContainer = messageElement.closest('.chat-msg');

    if (!messageContainer) {
      logger.error('phone','[MessageActions] ❌ 找不到消息容器！messageElement:', messageElement.className);
      logger.error('phone','[MessageActions] messageElement的父元素:', messageElement.parentElement?.className);
      // 降级：直接删除bubbleElement（至少删除气泡）
      messageElement.remove();
    } else {
      logger.debug('phone','[MessageActions] 找到消息容器，准备删除:', {
        容器类名: messageContainer.className,
        消息ID: messageContainer.dataset.msgId,
        子元素数量: messageContainer.children.length
      });
      messageContainer.remove();
      logger.debug('phone','[MessageActions] ✅ 消息容器已删除');
    }

    // 🔍 详细日志：删除后的DOM状态
    const afterDomCount = chatContent?.querySelectorAll('.chat-msg').length || 0;
    logger.info('phone','📊 [删除后] 数据:', newHistory.length, '条(-', beforeDataCount - newHistory.length, ')，DOM:', afterDomCount, '条(-', beforeDomCount - afterDomCount, ')');

    // 3. 更新消息列表预览
    await updateContactItem(contactId);

    logger.info('phone','[MessageActions] 删除消息成功:', message.content?.substring(0, 20));
    closeMessageActions();
  } catch (error) {
    logger.error('phone','[MessageActions] 删除消息失败:', error);
  }
}

/**
 * 处理多选模式
 * 
 * @private
 * @param {Object} message - 消息对象（未使用，仅为保持接口一致）
 * 
 * @description
 * 进入多选模式，显示所有消息的复选框和底部工具栏
 */
function handleMultiSelect(message) {
  logger.info('phone','[MessageActions] 进入多选模式');
  closeMessageActions();
  
  // 获取当前显示的聊天页面容器
  const pageContainer = document.querySelector('.phone-chat-page:not([style*="display: none"])');
  if (pageContainer) {
    enterMultiSelectMode(pageContainer);
  } else {
    logger.error('phone','[MessageActions] 找不到聊天页面容器');
  }
}

/**
 * 处理引用消息
 * 
 * @private
 * @param {Object} message - 消息对象
 * @param {string} contactId - 联系人ID
 */
function handleQuote(message, contactId) {
  // 检查消息类型（支持text/emoji/image/quote）
  if (!['text', 'emoji', 'image', 'quote'].includes(message.type)) {
    // 显示提示
    const toast = document.createElement('div');
    toast.className = 'phone-toast phone-toast-warning';
    toast.textContent = '该类型消息暂不支持引用';
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2000);

    closeMessageActions();
    return;
  }

  // ✅ 引用的引用：转换为简化的消息对象（只引用回复部分）
  let messageToQuote = message;
  if (message.type === 'quote') {
    messageToQuote = {
      id: message.id,
      sender: message.sender,
      time: message.time,
      type: 'text',  // 转换为text类型
      content: message.replyContent  // 只引用回复部分
    };
    logger.debug('phone','[MessageActions] 引用的引用，简化为文本:', message.replyContent?.substring(0, 20));
  }

  // 触发自定义事件，通知聊天页面
  const event = new CustomEvent('phone-message-quote', {
    detail: { message: messageToQuote, contactId }
  });
  document.dispatchEvent(event);

  logger.info('phone','[MessageActions] 引用消息:', messageToQuote.content?.substring(0, 20) || `[${messageToQuote.type}]`);
  closeMessageActions();
}

