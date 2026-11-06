/**
 * 戳一戳消息渲染器
 * @module phone/messages/message-types/poke-message
 * 
 * @description
 * 渲染戳一戳消息（特殊交互类型）
 * - 我发的：(👈 + 左震动
 * - 对方发的：👉) + 右震动
 */

import { getThumbnailUrl } from '/script.js';
import logger from '../../../../logger.js';

/**
 * 渲染戳一戳消息
 * 
 * @param {Object} message - 消息对象
 * @param {string} message.sender - 发送者（'user' | 'contact'）
 * @param {number} message.time - 时间戳（秒）
 * @param {string} message.id - 消息ID
 * @param {Object} contact - 联系人对象（用于获取头像）
 * @param {string} [contactId] - 联系人ID
 * @returns {HTMLElement} 戳一戳消息元素
 * 
 * @example
 * const poke = renderPokeMessage(
 *   { sender: 'user', time: 1730976543, id: 'msg_xxx' },
 *   { avatar: 'path/to/avatar.png' },
 *   'tavern_张三'
 * );
 */
export function renderPokeMessage(message, contact, contactId) {
  logger.debug('phone','[PokeMessage]] 开始渲染戳一戳消息:', message.id);

  const container = document.createElement('div');
  // ✅ 添加 .chat-msg 基础类名（让重roll逻辑能识别）
  container.className = 'chat-msg chat-msg-poke';

  // 判断是发送还是接收
  const isSent = message.sender === 'user';
  container.classList.add(isSent ? 'chat-msg-poke-sent' : 'chat-msg-poke-received');
  
  // ✅ 统一data-属性格式（和其他消息类型一致）
  container.dataset.msgId = message.id;
  container.dataset.messageTime = message.time.toString();
  container.dataset.time = message.time.toString();
  container.dataset.sender = message.sender;
  container.dataset.type = 'poke';
  container.dataset.messageId = message.id;
  container.dataset.contactId = contactId;

  // 创建头像
  const avatar = document.createElement('img');
  avatar.className = 'chat-msg-avatar';

  if (isSent) {
    // 用户头像（从顶部栏获取，完整路径，不压缩）
    const userAvatar = /** @type {HTMLImageElement} */ (document.querySelector('#phone-user-avatar'));
    avatar.src = userAvatar?.src || 'img/default-user.png';
    logger.debug('phone','[PokeMessage]] 用户头像src:', avatar.src);
  } else {
    // 联系人头像（使用getThumbnailUrl，不压缩）
    avatar.src = getThumbnailUrl('avatar', contact?.avatar) || 'img/default-avatar.png';
    logger.debug('phone','[PokeMessage]] 联系人头像src:', avatar.src);
  }

  avatar.alt = isSent ? '我' : contact?.name || '联系人';

  // 创建戳一戳内容
  const content = document.createElement('div');
  content.className = 'chat-msg-poke-content';

  // 弧线符号
  const arc = document.createElement('span');
  arc.className = 'chat-msg-poke-arc';
  arc.textContent = isSent ? '(' : ')';

  // 手指emoji
  const hand = document.createElement('span');
  hand.className = 'chat-msg-poke-hand';
  hand.textContent = isSent ? '👈' : '👉';

  content.appendChild(arc);
  content.appendChild(hand);

  // 组装（DOM顺序：头像在前，内容在后）
  // CSS的 flex-direction 会控制视觉顺序
  container.appendChild(avatar);
  container.appendChild(content);

  // 长按操作菜单由 message-chat-ui.js 统一绑定

  logger.info('phone','[PokeMessage]] ✅ 戳一戳消息渲染完成:', message.id, isSent ? '(我发的)' : '(对方发的)');

  return container;
}

