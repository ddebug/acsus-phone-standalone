import { extension_settings, saveSettingsDebounced } from '../../../standalone/phone-settings.js';
/**
 * AI上下文构建器
 * @module phone/ai-integration/ai-context-builder
 *
 * @description
 * 构建完整的AI提示词，包括：
 * - 头部破限
 * - 角色卡（人设 + 线下剧情 + 世界书）
 * - 手机聊天记录
 * - 格式要求
 * - 尾部破限
 */

import logger from '../../../logger.js';
import { loadContacts } from '../contacts/contact-list-data.js';
import { getContext } from '/scripts/st-context.js';
import { loadChatHistory } from '../messages/message-chat-data.js';
import { characters, chat, this_chid, getRequestHeaders } from '/script.js';

import { power_user } from '/scripts/power-user.js';
import { chat_completion_sources, oai_settings } from '/scripts/openai.js';
import { getDefaultPresets } from '../settings/preset-settings-ui.js';
/**
 * 获取角色数据
 * @private
 * @param {Object} contact - 联系人对象
 * @returns {Object|null} 角色数据
 */
function getCharacterData(contact) {
  // 从contactId提取角色名（去掉'tavern_'前缀）
  const charName = contact.id.replace(/^tavern_/, '');

  // 在酒馆角色列表中查找
  const character = characters.find(c => {
    const avatar = c.avatar?.replace(/\.[^/.]+$/, ''); // 去掉扩展名
    return avatar === charName;
  });

  if (!character) {
    logger.warn('phone','[ContextBuilder] 未找到对应的酒馆角色:', charName);
    return null;
  }

  logger.debug('phone','[ContextBuilder] 找到酒馆角色:', character.name);
  return character;
}

/**
 * 获取酒馆最近的上下文（同步版本，使用全局chat变量）
 * @private
 * @param {number} count - 获取条数（默认5）
 * @returns {string} 线下剧情聊天记录
 */
function getRecentTavernContext(count = 5) {
  if (!chat || chat.length === 0) {
    return '（无线下剧情）\n';
  }

  const recentMessages = chat.slice(-count);
  let context = '';

  recentMessages.forEach(msg => {
    const senderName = msg.is_user ? '你' : msg.name;
    context += `${senderName}: ${msg.mes}\n`;
  });

  return context;
}

/**
 * 获取特定角色的线下剧情（酒馆聊天记录，异步版本）
 *
 * @async
 * @private
 * @param {Object} character - 酒馆角色对象
 * @param {number} count - 获取条数（默认5）
 * @returns {Promise<string>} 线下剧情聊天记录
 *
 * @description
 * ✅ 2025-11-29 新增：应用角色的正则配置处理文本
 */
async function getCharacterTavernContext(character, count = 5) {
  if (!character) {
    return '（该角色不存在）\n';
  }

  try {
    // 检查是否是当前在酒馆中打开的角色
    const isCurrentCharacter = this_chid !== undefined &&
      characters[this_chid] &&
      characters[this_chid].avatar === character.avatar;

    let chatMessages = [];

    if (isCurrentCharacter) {
      // 如果是当前角色，直接使用全局chat变量（快速）
      logger.debug('phone','[ContextBuilder] 使用当前打开的聊天记录:', character.name);
      chatMessages = chat || [];
    } else {
      // 如果不是当前角色，需要调用API获取该角色的聊天记录
      logger.debug('phone','[ContextBuilder] 从服务器获取角色聊天记录:', character.name);

      if (!character.chat) {
        // 该角色还没有聊天记录
        return '（该角色还没有聊天记录）\n';
      }

      // 调用SillyTavern的API获取聊天记录
      const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
          ch_name: character.name,
          file_name: character.chat,
          avatar_url: character.avatar,
        }),
      });

      if (!response.ok) {
        logger.warn('phone','[ContextBuilder] 获取聊天记录失败:', response.status);
        return '（无法获取聊天记录）\n';
      }

      chatMessages = await response.json();
    }

    // 如果没有聊天记录
    if (!chatMessages || chatMessages.length === 0) {
      return '（无线下剧情）\n';
    }

    // 获取最近N条消息
    const recentMessages = chatMessages.slice(-count);
    logger.debug('phone',`[ContextBuilder] 获取酒馆上下文: 总消息=${chatMessages.length}条, 请求=${count}条, 实际获取=${recentMessages.length}条`);

    const contactId = `tavern_${character.avatar.replace(/\.[^/.]+$/, '')}`;
    let context = '';

    // ✅ 对每条消息单独应用正则（像酒馆一样），再拼接
    for (const msg of recentMessages) {
      if (!msg.mes) continue;  // 跳过无效消息

      const senderName = msg.name || (msg.is_user ? '你' : character.name);
      const processedText = await applyRegexToContext(msg.mes, contactId);
      context += `${senderName}: ${processedText}\n`;
    }

    return context;

  } catch (error) {
    logger.error('phone','[ContextBuilder] 获取线下剧情失败:', error);
    return '（获取线下剧情失败）\n';
  }
}

/**
 * 应用正则处理到上下文文本
 *
 * @private
 * @async
 * @param {string} text - 原始文本
 * @param {string} contactId - 联系人ID
 * @returns {Promise<string>} 处理后的文本
 *
 * @description
 * 调用 storage-regex.js 的 applyContactRegex 函数
 * 只处理 only_format_prompt 为 true 的正则
 */
async function applyRegexToContext(text, contactId) {
  try {
    // 动态导入正则处理模块
    const { applyContactRegex } = await import('../data-storage/storage-regex.js');
    return applyContactRegex(text, contactId);
  } catch (error) {
    logger.error('phone','[ContextBuilder] 应用正则失败:', error);
    return text;  // 失败时返回原文本
  }
}

/**
 * 格式化时间戳
 * @private
 * @param {number} timestamp - 时间戳（秒）
 * @returns {string} 格式化后的时间字符串
 */
function formatTimestamp(timestamp) {
  const date = new Date(timestamp * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/**
 * 提取被触发的联系人ID列表（从待发送消息中提取）
 *
 * @async
 * @private
 * @param {Object} allPendingMessages - 所有待发送消息（按联系人ID分组）
 * @returns {Promise<string[]>} 被触发的联系人ID数组（有消息的联系人 + AI感知删除触发的联系人）
 *
 * @description
 * 从 allPendingMessages 中提取所有有消息的 contactId
 * 同时检查AI感知删除触发的角色，合并到触发列表中
 * 用于多角色触发场景（给多个角色发消息 + AI感知删除申请）
 */
async function extractTriggeredContactIds(allPendingMessages) {
  if (!allPendingMessages || typeof allPendingMessages !== 'object') {
    logger.warn('phone','[ContextBuilder.extractTriggeredContactIds] allPendingMessages 为空或格式错误');
    return [];
  }

  // 提取所有有消息的 contactId
  const triggeredIds = Object.keys(allPendingMessages).filter(id => {
    const messages = allPendingMessages[id];
    return Array.isArray(messages) && messages.length > 0;
  });

  // ✅ 检查AI感知删除触发的角色，并添加到触发列表
  const triggeredRequests = await checkAndTriggerAIAwareReapply();
  if (triggeredRequests.length > 0) {
    // ✅ 按删除时间排序（早删除的排前面）
    triggeredRequests.sort((a, b) => a.deleteTime - b.deleteTime);
    const aiTriggeredIds = triggeredRequests.map(r => r.contactId);

    // ✅ 合并列表：被删除的角色排在前面，当前聊天角色排在后面，去重
    const allTriggeredIds = [...new Set([...aiTriggeredIds, ...triggeredIds])];

    logger.debug('phone','[ContextBuilder.extractTriggeredContactIds] 提取到', triggeredIds.length, '个有消息的联系人:', triggeredIds);
    logger.debug('phone','[ContextBuilder.extractTriggeredContactIds] 提取到', aiTriggeredIds.length, '个AI感知删除触发的联系人（按删除时间排序）:', aiTriggeredIds);
    logger.debug('phone','[ContextBuilder.extractTriggeredContactIds] 合并后共', allTriggeredIds.length, '个被触发的联系人:', allTriggeredIds);
    return allTriggeredIds;
  }

  logger.debug('phone','[ContextBuilder.extractTriggeredContactIds] 提取到', triggeredIds.length, '个被触发的联系人:', triggeredIds);
  return triggeredIds;
}

/**
 * 构建messages数组（新版，使用预设系统，支持多角色触发）
 *
 * @async
 * @param {string} contactId - 主联系人ID（当前打开的聊天页面，如果不存在会从触发列表中找第一个）
 * @param {Object} allPendingMessages - 所有待发送消息（按联系人ID分组）格式：{ contactId: [messages] }
 * @returns {Promise<Object>} { messages: messages数组, messageNumberMap: 编号映射表 }
 *
 * @description
 * 根据预设列表构建messages数组，每个预设项对应一条消息。
 * 支持三种角色类型（system/user/assistant）。
 * 自动替换特殊占位符（如__AUTO_CHARACTERS__、__AUTO_CHAT_HISTORY__、user待操作）。
 *
 * ✅ 多角色触发机制（2025-11-07新增）：
 * - 从 allPendingMessages 提取所有被触发的联系人ID
 * - 为每个被触发的角色构建角色卡和聊天记录
 * - 最新消息集中在 [{{user}}本轮操作] 中（保证AI注意力）
 *
 * ⚠️ 变量替换由 SillyTavern 的 MacrosParser 自动处理（不需要手动替换）：
 * - {{最新消息}}、{{历史消息}}、{{当前时间}} 等手机宏
 * - {{user}}、{{char}} 等官方宏
 * - 在 AI 调用前自动替换
 *
 * ✅ 消息编号机制（2025-10-29新增）：
 * - 每次构建时临时生成编号（#1, #2, #3...）
 * - 编号→消息ID映射表随messages一起返回
 * - 用于AI引用消息时精确查找原消息
 * - 编号每次重新构建，不累积
 */
export async function buildMessagesArray(contactId, allPendingMessages) {
  logger.info('phone','[ContextBuilder.buildMessagesArray] 开始构建messages数组 - 主联系人:', contactId);

  // ✅ 读取 API 配置源（决定是否使用结构化消息）
  const apiSource = extension_settings.acsusStandalonePhone?.phone?.apiConfig?.source || 'default';
  logger.info('phone','[ContextBuilder.buildMessagesArray] API配置源:', apiSource, apiSource === 'custom' ? '（支持多模态数组）' : '（仅支持纯文本）');

  // ✅ 提取被触发的联系人ID（有消息的才算触发）
  const triggeredContactIds = await extractTriggeredContactIds(allPendingMessages);
  logger.info('phone','[ContextBuilder.buildMessagesArray] 共触发', triggeredContactIds.length, '个联系人:', triggeredContactIds);

  // ✅ 创建消息编号映射表（编号 → 消息ID）
  const messageNumberMap = new Map();
  let currentNumber = 1;

  // ✅ 收集待附加的图片
  let collectedImages = [];

  // 获取预设数据
  const presets = getPresetData();

  // 构建messages数组
  const messages = [];

  // 按order排序
  const sortedItems = presets.items.filter(item => item.enabled).sort((a, b) => a.order - b.order);

  for (const item of sortedItems) {
    let content = item.content;

    // ✅ 通过 item.id 判断，而不是检测占位符
    if (item.id === 'char-info') {
      // ✅ 构建多个角色的角色总条目（传递触发的联系人ID列表）
      const charResult = await buildAllCharacterInfo(triggeredContactIds, messageNumberMap, currentNumber);
      content = charResult.content;
      currentNumber = charResult.nextNumber;
    } else if (item.id === 'chat-history') {
      // ✅ 构建多个角色的聊天记录（传递触发的联系人ID列表和API配置）
      const chatResult = await buildAllChatHistoryInfo(triggeredContactIds, messageNumberMap, currentNumber, apiSource);

      // ✅ 检查返回类型：结构化消息（自定义API）还是纯文本（默认API）
      if (chatResult.structuredMessages && apiSource === 'custom') {
        // 🔥 自定义API：直接插入结构化消息到 messages 数组
        messages.push(...chatResult.structuredMessages);
        logger.info('phone','[ContextBuilder.buildMessagesArray] ✅ 已插入', chatResult.structuredMessages.length, '条结构化消息');

        // 🔍 调试：打印每条消息的 role 和是否有签名
        chatResult.structuredMessages.forEach((msg, idx) => {
          const hasSignature = Array.isArray(msg.content) && msg.content.some(part => part.thoughtSignature);
          logger.debug('phone',`[ContextBuilder.buildMessagesArray] 结构化消息[${idx}] role=${msg.role}, hasSignature=${hasSignature}`);
          if (hasSignature) {
            const signaturePart = msg.content.find(part => part.thoughtSignature);
            logger.info('phone',`[ContextBuilder.buildMessagesArray] 🎯 消息[${idx}] 包含 thoughtSignature，长度: ${signaturePart.thoughtSignature.length}`);
          }
        });

        content = null;  // ← 标记为已处理，跳过后续的通用添加逻辑
      } else {
        // ✅ 默认API：使用纯文本 content
        content = chatResult.content;
      }

      currentNumber = chatResult.nextNumber;

      // ✅ 收集历史消息中的图片（imageMode='always'时有值）
      if (chatResult.historyImages && chatResult.historyImages.length > 0) {
        collectedImages.push(...chatResult.historyImages);
        logger.info('phone','[ContextBuilder.buildMessagesArray] 检测到历史图片，数量:', chatResult.historyImages.length);
        logger.debug('phone','[ContextBuilder.buildMessagesArray] 历史图片列表:', chatResult.historyImages.map(img => img.url));
      }

      // ✅ 如果是结构化消息，跳过后续的通用添加逻辑
      if (content === null) {
        continue;
      }
    } else if (item.id === 'signature-history') {
      // 构建用户个签历史
      content = await buildSignatureHistory();
    } else if (item.id === 'user-pending-ops') {
      // ✅ 构建用户待操作（传递映射表和当前编号，接收筛选后的图片列表）
      const pendingResult = await buildUserPendingOps(allPendingMessages, messageNumberMap, currentNumber);
      content = pendingResult.content;
      currentNumber = pendingResult.nextNumber;

      // ✅ 存储图片列表
      const imagesToAttach = pendingResult.imagesToAttach || [];

      // ✅ 关键修复：先添加 user 消息到 messages，再附加图片
      // 即使 content 为空，只要有图片，也要创建 user 消息
      if (imagesToAttach.length > 0) {
        // 有图片：必须创建 user 消息（即使 content 为空）
        messages.push({
          role: item.role || 'user',
          content: content || ''
        });
        logger.debug('phone','[ContextBuilder.buildMessagesArray] ✅ 已添加user-pending-ops消息（含图片）');
      } else if (content && content.trim()) {
        // 无图片但有文本：正常添加
        messages.push({
          role: item.role || 'user',
          content: content
        });
        logger.debug('phone','[ContextBuilder.buildMessagesArray] ✅ 已添加user-pending-ops消息（仅文本）');
      } else {
        // 无图片且无文本：跳过
        logger.debug('phone','[ContextBuilder.buildMessagesArray] ⏭️ 跳过空的user-pending-ops');
      }

      // ✅ 保存待发送消息中的图片信息，稍后在事件中附加
      if (imagesToAttach.length > 0) {
        collectedImages.push(...imagesToAttach);  // ← 追加而不是覆盖，以便合并历史图片
        logger.info('phone','[ContextBuilder.buildMessagesArray] 检测到待发送图片，数量:', imagesToAttach.length);
        logger.debug('phone','[ContextBuilder.buildMessagesArray] 待发送图片列表:', imagesToAttach.map(img => img.url));
      }

      // ✅ 输出最终图片总数
      if (collectedImages.length > 0) {
        logger.info('phone','[ContextBuilder.buildMessagesArray] ✅ 图片总数（历史+待发送）:', collectedImages.length, '将在宏替换后通过事件附加');
      }

      // ✅ user-pending-ops 已处理完毕，跳过后面的通用添加逻辑
      continue;
    } else if (item.id === 'emoji-library') {
      // 表情包库：动态生成表情包列表 + 用户提示词
      content = await buildEmojiLibrary(item.content);
    }

    // ✅ 替换自定义占位符
    if (typeof content === 'string' && content.includes('__AUTO_USER_PERSONA__')) {
      // 获取用户设定描述
      const personaDesc = power_user.persona_description || '';
      content = content.replace(/__AUTO_USER_PERSONA__/g, personaDesc);
      logger.debug('phone','[ContextBuilder.buildMessagesArray] 已替换用户设定占位符');
    }

    // ✅ 变量替换由 SillyTavern 的 MacrosParser 自动处理
    // 手机宏（{{最新消息}}、{{历史消息}}、{{当前时间}}等）会在 API 调用前自动替换

    // 添加到messages（只有内容非空时才添加）
    // ✅ 修复：过滤空字符串，避免API报错
    if (content && content.trim()) {
      messages.push({
        role: item.role || 'system',
        content: content
      });
    } else if (content === '') {
      logger.debug('phone','[ContextBuilder.buildMessagesArray] 跳过空内容条目:', item.label);
    }
  }

  logger.info('phone','[ContextBuilder.buildMessagesArray] 构建完成，共', messages.length, '条消息');
  logger.info('phone','[ContextBuilder.buildMessagesArray] 消息编号映射表大小:', messageNumberMap.size);

  // ✅ 宏替换：使用 substituteParams（自动处理所有宏，包括{{user}}、{{char}}和手机宏）
  try {
    const { substituteParams } = SillyTavern.getContext();
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        const originalContent = msg.content;
        // substituteParams 会自动替换所有宏：酒馆内置宏 + 手机注册的宏
        msg.content = substituteParams(msg.content);
        if (originalContent !== msg.content) {
          logger.debug('phone','[ContextBuilder.buildMessagesArray] ✅ 宏已替换，样例:', originalContent.substring(0, 50), '→', msg.content.substring(0, 50));
        }
      }
    }
    logger.info('phone','[ContextBuilder.buildMessagesArray] ✅ 所有消息宏替换完成');
  } catch (error) {
    logger.error('phone','[ContextBuilder.buildMessagesArray] 宏替换失败:', error);
  }

  logger.debug('phone','[ContextBuilder.buildMessagesArray] messages内容:', JSON.stringify(messages, null, 2));

  return {
    messages,
    messageNumberMap,
    imagesToAttach: collectedImages  // ✅ 返回收集到的图片列表
  };
}

/**
 * 构建所有被触发角色的角色档案（多角色版本）
 *
 * @async
 * @private
 * @param {string[]} triggeredContactIds - 被触发的联系人ID列表
 * @param {Map<number, string>} messageNumberMap - 消息编号映射表
 * @param {number} startNumber - 起始编号
 * @returns {Promise<Object>} { content: 所有角色的角色档案内容, nextNumber: 下一个可用编号 }
 *
 * @description
 * 为每个被触发的角色构建角色卡（人设、线下剧情等）
 * 格式：
 * [角色卡-Wade Wilson]
 *   [人设]...
 *   [线下剧情]...
 * [/角色卡-Wade Wilson]
 *
 * [角色卡-Jerry Hickfang]
 *   [人设]...
 *   [线下剧情]...
 * [/角色卡-Jerry Hickfang]
 */
async function buildAllCharacterInfo(triggeredContactIds, messageNumberMap, startNumber) {
  logger.info('phone','[ContextBuilder.buildAllCharacterInfo] 开始构建多角色档案，共', triggeredContactIds.length, '个角色');

  if (!triggeredContactIds || triggeredContactIds.length === 0) {
    logger.warn('phone','[ContextBuilder.buildAllCharacterInfo] 没有被触发的角色，返回空内容');
    return { content: '', nextNumber: startNumber };
  }

  // 加载所有联系人数据
  const contacts = await loadContacts();

  let allContent = '';
  let currentNumber = startNumber;

  // 遍历每个被触发的联系人
  for (const contactId of triggeredContactIds) {
    logger.debug('phone','[ContextBuilder.buildAllCharacterInfo] 处理角色:', contactId);

    // 查找联系人
    let contact = contacts.find(c => c.id === contactId);

    // 如果联系人不存在，可能是AI感知删除的角色，尝试从酒馆角色列表查找
    if (!contact && contactId.startsWith('tavern_')) {
      const characterName = contactId.replace('tavern_', '');
      const character = getContext().characters.find(c => c.avatar === `${characterName}.png`);

      if (character) {
        logger.info('phone','[ContextBuilder.buildAllCharacterInfo] AI感知删除角色，从酒馆直接获取:', characterName);
        // 创建临时contact对象
        contact = {
          id: contactId,
          name: characterName,
          source: 'tavern'
        };
      }
    }

    if (!contact) {
      logger.warn('phone','[ContextBuilder.buildAllCharacterInfo] 联系人不存在，跳过:', contactId);
      continue;
    }

    // 获取酒馆角色数据
    const character = getCharacterData(contact);

    // 构建单个角色的角色卡
    const charResult = await buildCharacterInfo(contact, character, messageNumberMap, currentNumber);

    // 添加到总内容（换行分隔）
    if (charResult.content && charResult.content.trim()) {
      allContent += charResult.content + '\n\n';
      currentNumber = charResult.nextNumber;
      logger.debug('phone','[ContextBuilder.buildAllCharacterInfo] 角色档案已添加:', contact.name, '当前编号:', currentNumber);
    }
  }

  // 去掉末尾多余的换行
  allContent = allContent.trim();

  logger.info('phone','[ContextBuilder.buildAllCharacterInfo] 多角色档案构建完成，共处理', triggeredContactIds.length, '个角色');
  logger.debug('phone','[ContextBuilder.buildAllCharacterInfo] 内容长度:', allContent.length, '字符');

  return {
    content: allContent,
    nextNumber: currentNumber
  };
}

/**
 * 构建所有被触发角色的QQ聊天记录（多角色版本）
 *
 * @async
 * @private
 * @param {string[]} triggeredContactIds - 被触发的联系人id列表
 * @param {Map<number, string>} messageNumberMap - 消息编号映射表
 * @param {number} startNumber - 起始编号
 * @param {string} apiSource - API配置源（'default'=酒馆API, 'custom'=自定义API）
 * @returns {Promise<Object>} { content: 所有角色的聊天记录内容, nextNumber: 下一个可用编号, historyImages: 历史消息中需要重新发送的图片列表 }
 *
 * @description
 * 为每个被触发的角色构建最新的聊天记录
 * 格式：
 * [角色-Wade Wilson]
 * [消息]
 *   [#1] [21:00] Wade: 你好
 *   [#2] [21:01] 白沉: 嗨
 * [/消息]
 * [/角色-Wade Wilson]
 *
 * [角色-Jerry Hickfang]
 * [消息]
 *   [#3] [20:50] Jerry: 在干嘛
 *   [#4] [20:51] 白沉: 工作
 * [/消息]
 * [/角色-Jerry Hickfang]
 */
async function buildAllChatHistoryInfo(triggeredContactIds, messageNumberMap, startNumber, apiSource = 'default') {
  logger.info('phone','[ContextBuilder.buildAllChatHistoryInfo] 开始构建多角色聊天记录，共', triggeredContactIds.length, '个角色');

  if (!triggeredContactIds || triggeredContactIds.length === 0) {
    logger.warn('phone','[ContextBuilder.buildAllChatHistoryInfo] 没有被触发的角色，返回空内容');
    return { content: '', nextNumber: startNumber, historyImages: [] };
  }

  // 加载所有联系人数据
  const contacts = await loadContacts();

  let allContent = '';
  let allStructuredMessages = [];  // ✅ 收集所有角色的结构化消息（自定义API专用）
  let allHistoryImages = [];  // ✅ 收集所有角色的历史图片
  let currentNumber = startNumber;

  // 遍历每个被触发的联系人
  for (const contactId of triggeredContactIds) {
    logger.debug('phone','[ContextBuilder.buildAllChatHistoryInfo] 处理角色:', contactId);

    // 查找联系人
    let contact = contacts.find(c => c.id === contactId);

    // 如果联系人不存在，可能是AI感知删除的角色，尝试从酒馆角色列表查找
    if (!contact && contactId.startsWith('tavern_')) {
      const characterName = contactId.replace('tavern_', '');
      const character = getContext().characters.find(c => c.avatar === `${characterName}.png`);

      if (character) {
        logger.info('phone','[ContextBuilder.buildAllChatHistoryInfo] AI感知删除角色，从酒馆直接获取:', characterName);
        // 创建临时contact对象
        contact = {
          id: contactId,
          name: characterName,
          source: 'tavern'
        };
      }
    }

    if (!contact) {
      logger.warn('phone','[ContextBuilder.buildAllChatHistoryInfo] 联系人不存在，跳过:', contactId);
      continue;
    }

    // 构建单个角色的聊天记录（返回 parts 数组或结构化消息，传递 apiSource）
    const chatResult = await buildChatHistoryInfo(contactId, contact, messageNumberMap, currentNumber, apiSource);

    // ✅ 检查返回类型：结构化消息（自定义API）还是 parts 数组（默认API）
    if (chatResult.structuredMessages) {
      // 🔥 自定义API：收集结构化消息数组（稍后在 buildMessagesArray 中插入）
      allStructuredMessages.push(...chatResult.structuredMessages);
      currentNumber = chatResult.nextNumber;
      logger.debug('phone','[ContextBuilder.buildAllChatHistoryInfo] 结构化消息已收集:', contact.name, '消息数量:', chatResult.structuredMessages.length);

      // ✅ 合并历史图片
      if (chatResult.historyImages && chatResult.historyImages.length > 0) {
        allHistoryImages.push(...chatResult.historyImages);
        logger.debug('phone','[ContextBuilder.buildAllChatHistoryInfo] 历史图片已添加:', contact.name, '图片数量:', chatResult.historyImages.length);
      }
    } else if (chatResult.parts && chatResult.parts.length > 0) {
      // ✅ 默认API：将 parts 数组转换为纯文本（保持向后兼容）
      const contentText = chatResult.parts
        .filter(part => part.type === 'text')  // 只提取文本片段
        .map(part => part.text)
        .join('');

      if (contentText.trim()) {
        allContent += contentText + '\n\n';
        currentNumber = chatResult.nextNumber;
        logger.debug('phone','[ContextBuilder.buildAllChatHistoryInfo] 聊天记录已添加:', contact.name, '当前编号:', currentNumber);
      }

      // ✅ 合并历史图片
      if (chatResult.historyImages && chatResult.historyImages.length > 0) {
        allHistoryImages.push(...chatResult.historyImages);
        logger.debug('phone','[ContextBuilder.buildAllChatHistoryInfo] 历史图片已添加:', contact.name, '图片数量:', chatResult.historyImages.length);
      }
    }
  }

  // 去掉末尾多余的换行
  allContent = allContent.trim();

  logger.info('phone','[ContextBuilder.buildAllChatHistoryInfo] 多角色聊天记录构建完成，共处理', triggeredContactIds.length, '个角色');

  // ✅ 根据 API 配置源返回不同格式
  if (apiSource === 'custom' && allStructuredMessages.length > 0) {
    // 🔥 自定义API：返回结构化消息数组
    logger.debug('phone','[ContextBuilder.buildAllChatHistoryInfo] 结构化消息总数:', allStructuredMessages.length);
    logger.debug('phone','[ContextBuilder.buildAllChatHistoryInfo] 历史图片总数:', allHistoryImages.length);

    return {
      structuredMessages: allStructuredMessages,  // ← 返回结构化消息数组
      nextNumber: currentNumber,
      historyImages: allHistoryImages
    };
  } else {
    // ✅ 默认API：返回纯文本
    logger.debug('phone','[ContextBuilder.buildAllChatHistoryInfo] 内容长度:', allContent.length, '字符');
    logger.debug('phone','[ContextBuilder.buildAllChatHistoryInfo] 历史图片总数:', allHistoryImages.length);

    return {
      content: allContent,
      nextNumber: currentNumber,
      historyImages: allHistoryImages  // ← 返回所有角色的历史图片
    };
  }
}

/**
 * 构建角色总条目内容
 *
 * @description
 * 优先使用角色专属配置（characterPrompts），如果不存在则使用默认逻辑（兼容旧版本）
 *
 * @private
 * @param {Object} contact - 联系人对象
 * @param {Object|null} character - 酒馆角色数据
 * @param {Map<number, string>} messageNumberMap - 消息编号映射表
 * @param {number} startNumber - 起始编号
 * @returns {Promise<Object>} { content: 角色总条目内容, nextNumber: 下一个可用编号 }
 */
async function buildCharacterInfo(contact, character, messageNumberMap, startNumber) {
  // 检查是否有角色专属配置
  const charPromptConfig = extension_settings.acsusStandalonePhone?.phone?.characterPrompts?.[contact.id];

  if (charPromptConfig && charPromptConfig.items) {
    // 使用角色专属配置构建（传递映射表和编号）
    logger.debug('phone','[ContextBuilder] 使用角色专属配置构建角色总条目:', contact.name);
    return await buildCharacterInfoFromConfig(contact, character, charPromptConfig, messageNumberMap);
  }

  // 兼容旧版本：使用默认逻辑（无编号）
  logger.debug('phone','[ContextBuilder] 使用默认逻辑构建角色总条目:', contact.name);
  let content = `[角色卡-${contact.name}]\n`;

  if (character) {
    content += '[人设]\n';
    content += `${character.description || '（无人设）'}\n`;
    content += '[/人设]\n\n';

    content += '[线下剧情]\n';
    content += await getCharacterTavernContext(character, 5);
    content += '[/线下剧情]\n\n';
  }

  content += `[/角色卡-${contact.name}]`;

  return {
    content,
    nextNumber: startNumber  // 旧版本不加编号，返回原编号
  };
}

/**
 * 根据角色专属配置构建角色总条目
 * @private
 * @param {Object} contact - 联系人对象
 * @param {Object|null} character - 酒馆角色数据
 * @param {Object} config - 角色配置对象
 * @param {Map<number, string>} messageNumberMap - 消息编号映射表（编号→消息ID）
 * @returns {Promise<Object>} { content: 角色总条目内容, nextNumber: 下一个可用编号 }
 */
async function buildCharacterInfoFromConfig(contact, character, config, messageNumberMap) {
  let content = `[角色卡-${contact.name}]\n`;
  let currentNumber = 1;

  // 按order排序，只处理启用的条目
  const enabledItems = config.items.filter(item => item.enabled).sort((a, b) => a.order - b.order);

  for (const item of enabledItems) {
    let itemContent = '';
    let itemNextNumber = currentNumber;

    // 根据类型获取内容
    switch (item.type) {
      case 'auto':
        // 自动获取角色数据
        if (item.content === '__AUTO_CHAR_DESC__' && character) {
          itemContent = character.description || '';
        } else if (item.content === '__AUTO_CHAR_PERSONALITY__' && character) {
          itemContent = character.personality || '';
        } else if (item.content === '__AUTO_CHAR_SCENARIO__' && character) {
          itemContent = character.scenario || '';
        }
        break;

      case 'tavern-context':
        // 线下剧情（异步获取特定角色的聊天记录）
        const count = item.contextCount || 5;
        logger.debug('phone',`[ContextBuilder] 酒馆上下文配置: contextCount=${item.contextCount}, 实际使用count=${count}`);
        itemContent = await getCharacterTavernContext(character, count);
        logger.debug('phone',`[ContextBuilder] 酒馆上下文获取结果长度: ${itemContent.length}字符`);
        break;

      case 'history-chat':
        // 历史聊天记录（从message-chat-data获取，返回编号映射）
        const historyResult = await buildHistoryChatInfo(contact.id, contact, messageNumberMap);
        itemContent = historyResult.content;
        itemNextNumber = historyResult.nextNumber;
        currentNumber = itemNextNumber;  // 更新当前编号
        break;

      case 'worldbook':
      case 'custom':
        // 世界书条目或自定义条目，直接使用content
        itemContent = item.content || '';
        break;
    }

    // 只添加非空内容
    if (itemContent && itemContent.trim()) {
      // 添加标签（去掉方括号）
      const label = item.label.replace(/^\[|\]$/g, '');
      content += `[${label}]\n${itemContent}\n[/${label}]\n\n`;
    }
  }

  content += `[/角色卡-${contact.name}]`;

  logger.debug('phone','[ContextBuilder] 角色总条目构建完成，使用了', enabledItems.length, '个条目');

  return {
    content,
    nextNumber: currentNumber
  };
}

/**
 * 构建聊天记录（结构化版本，仅用于自定义API）
 *
 * @async
 * @private
 * @param {string} contactId - 联系人ID
 * @param {Object} contact - 联系人对象
 * @param {Map} messageNumberMap - 消息编号映射表
 * @param {number} startNumber - 起始编号
 * @param {number} currentRound - 当前轮次
 * @param {Object} sendSettings - 发送设置
 * @param {string} userName - 用户显示名
 * @returns {Promise<Object>} { structuredMessages: 结构化消息数组, nextNumber: 下一个可用编号, historyImages: 历史图片列表 }
 *
 * @description
 * 🔥 自定义API专用：将 recentCount 内的消息拆分成独立的 role
 * - 带图片的消息：独立的 user/assistant role，content 为数组 [{type: 'text'}, {type: 'image_url'}]
 * - 纯文字消息：合并到一个 system role，保持连续性
 *
 * 返回格式：
 * {
 *   structuredMessages: [
 *     { role: 'system', content: '[角色-Wade]\n[消息]\n#1 白沉: 你好\n#2 Wade: 嗨' },
 *     { role: 'user', content: [{ type: 'text', text: '#3 白沉: ' }, { type: 'image_url', image_url: {...} }] },
 *     { role: 'system', content: '#4 Wade: 好可爱\n[/消息]\n[/角色-Wade]' }
 *   ],
 *   nextNumber: 5,
 *   historyImages: [{url, contactId, messageId, round}, ...]
 * }
 */
async function buildChatHistoryStructured(contactId, contact, messageNumberMap, startNumber, currentRound, sendSettings, userName, apiSource) {
  // 动态导入工具函数
  const { formatTimeForAI } = await import('../utils/time-helper.js');
  const { findEmojiById } = await import('../emojis/emoji-manager-data.js');

  const imageMode = extension_settings.acsusStandalonePhone?.phone?.imageMode || 'once';
  logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] imageMode:', imageMode);

  // 加载历史记录
  const allHistory = await loadChatHistory(contactId);
  const validHistory = allHistory.filter(msg => !msg.excluded);
  const recentHistory = validHistory.slice(Math.max(0, validHistory.length - sendSettings.recentCount));

  let structuredMessages = [];
  let historyImages = [];
  let currentNumber = startNumber;
  let textBuffer = `[角色-${contact.name}]\n[消息]\n`;  // 累积纯文字消息

  // ✅ 轮次合并状态（用于累积连续的 contact 消息）
  let turnBuffer = '';              // 当前轮次的消息文本
  let turnSignature = null;         // 当前轮次的签名（只在第一条消息提取）
  let turnStartNumber = currentNumber;  // 轮次起始编号
  let inContactTurn = false;        // 是否在 contact 的轮次中

  /**
   * Flush 当前 contact 轮次
   */
  const flushContactTurn = () => {
    if (!inContactTurn || !turnBuffer) return;

    if (turnSignature) {
      // ✅ 有签名 → 创建独立的 assistant role
      logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] ✅ Flush 带签名的 contact 轮次，编号范围:', turnStartNumber, '-', currentNumber - 1);

      // 🎯 检查当前 API 源：只有 Gemini (makersuite) 才包含签名
      const isGemini = apiSource === 'makersuite';
      logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] 当前 API 源:', apiSource, ', 是否包含签名:', isGemini);

      const contentPart = {
        type: 'text',
        text: turnBuffer.trim()
      };

      // 只有 Gemini 才附加签名
      if (isGemini && turnSignature) {
        contentPart.thoughtSignature = turnSignature;
        logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] ✅ 已附加 thoughtSignature');
      } else if (turnSignature) {
        logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] ⚠️ 跳过附加 thoughtSignature（非 Gemini 模型）');
      }

      structuredMessages.push({
        role: 'assistant',
        content: [contentPart]
      });
    } else {
      // ❌ 无签名 → 合并到 textBuffer
      logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] Flush 无签名的 contact 轮次到 textBuffer');
      textBuffer += turnBuffer;
    }

    // 重置轮次状态
    turnBuffer = '';
    turnSignature = null;
    inContactTurn = false;
  };

  if (recentHistory.length === 0) {
    // 没有历史消息
    return {
      structuredMessages: [{ role: 'system', content: `[角色-${contact.name}]\n[消息]\n[/消息]\n[/角色-${contact.name}]` }],
      nextNumber: currentNumber,
      historyImages: []
    };
  }

  // 遍历历史消息
  for (let index = 0; index < recentHistory.length; index++) {
    const msg = recentHistory[index];
    const senderName = msg.sender === 'user' ? userName : contact.name;
    const prevTime = index > 0 ? recentHistory[index - 1].time : null;
    const isFirst = index === 0;
    const timeStr = formatTimeForAI(msg.time, prevTime, isFirst);

    // 格式化消息内容
    let messageContent = msg.content;
    let hasRealImage = false;  // 标记是否有真实图片

    if (msg.type === 'poke') {
      messageContent = '[戳一戳]';
    } else if (msg.type === 'emoji') {
      const emoji = findEmojiById(msg.content);
      messageContent = emoji ? `[表情]${emoji.name}` : (msg.emojiName ? `[表情]${msg.emojiName}` : `[表情包已删除]`);
    } else if (msg.type === 'image-real' || (msg.type === 'image' && msg.imageUrl)) {
      // ✅ 真实图片：需要拆分成独立 role
      hasRealImage = true;
      const description = msg.description || '';

      // 检查是否需要附加图片（imageMode 和轮次判断）
      if (imageMode === 'always' && msg.imageUrl && msg.imageRound !== currentRound) {
        historyImages.push({
          url: msg.imageUrl,
          contactId: contactId,
          messageId: msg.id,
          round: msg.imageRound
        });
        logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] 🖼️ 历史图片将拆分:', msg.id, '轮次:', msg.imageRound);
      }
    } else if (msg.type === 'image-fake' || (msg.type === 'image' && !msg.imageUrl)) {
      messageContent = `[图片]${msg.description || '无描述'}`;
    } else if (msg.type === 'quote') {
      const quotedText = formatQuotedMessageForAI(msg.quotedMessage);
      messageContent = `[引用]${quotedText}[回复]${msg.replyContent}`;
    } else if (msg.type === 'transfer') {
      messageContent = msg.message ? `[转账]${msg.amount}元 ${msg.message}` : `[转账]${msg.amount}元`;
    } else if (msg.type === 'gift-membership') {
      const typeText = msg.membershipType === 'vip' ? 'VIP' : 'SVIP';
      messageContent = `[送会员]${msg.months}个月${typeText}会员`;
    } else if (msg.type === 'buy-membership') {
      const typeText = msg.membershipType === 'vip' ? 'VIP' : 'SVIP';
      messageContent = `[开会员]${msg.months}个月${typeText}会员`;
    } else if (msg.type === 'recalled') {
      messageContent = msg.sender === 'user' ? `【${userName}撤回了一条消息】` : `[撤回]${msg.originalContent || '(无内容)'}`;
    } else if (msg.type === 'forwarded') {
      messageContent = formatForwardedMessageForAI(msg, userName, formatTimeForAI);
    }

    // 🔥 关键逻辑：带真实图片的消息拆分成独立 role
    if (hasRealImage && msg.imageUrl) {
      // ✅ 判断是否应该发送图片给AI（根据 imageMode 和轮次）
      let shouldIncludeImage = false;
      if (imageMode === 'always') {
        shouldIncludeImage = true;
        logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] ✅ imageMode=always，历史图片将发送给AI，消息ID:', msg.id);
      } else if (imageMode === 'once' && msg.imageRound === currentRound) {
        shouldIncludeImage = true;
        logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] ✅ imageMode=once，当前轮次图片将发送给AI，消息ID:', msg.id, '轮次:', msg.imageRound);
      } else if (imageMode === 'once' && msg.imageRound !== currentRound) {
        logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] ⏭️ imageMode=once，历史轮次图片不发送，消息ID:', msg.id, '图片轮次:', msg.imageRound, '当前轮次:', currentRound);
      } else if (imageMode === 'never') {
        logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] 📵 imageMode=never，图片不发送给AI，消息ID:', msg.id);
      }

      if (shouldIncludeImage) {
        // ✅ 发送图片：创建独立的图片消息 role
        // ✅ 先 flush contact 轮次（图片会打断轮次累积）
        flushContactTurn();

        // ✅ 再 flush textBuffer
        if (textBuffer.trim() !== `[角色-${contact.name}]\n[消息]`.trim()) {
          structuredMessages.push({ role: 'system', content: textBuffer });
          textBuffer = '';  // 清空缓冲区
        }

        // 创建独立的图片消息 role
        const msgRole = msg.sender === 'user' ? 'user' : 'assistant';
        const description = msg.description || '';

        // ✅ 构建消息 content（文本 + 图片）
        const messageParts = [
          { type: 'text', text: `[#${currentNumber}] ${timeStr}${senderName}: ${description}` },
          { type: 'image_url', image_url: { url: msg.imageUrl } }  // 占位符，后续转base64
        ];

        // ✅ 检查是否有 API 元数据（仅 assistant 消息，仅 Gemini）
        const isGemini = apiSource === 'makersuite';
        if (msgRole === 'assistant' && msg.metadata?.gemini?.thoughtSignature && isGemini) {
          // ✅ 添加 thoughtSignature 到第一个 part（文本）
          messageParts[0].thoughtSignature = msg.metadata.gemini.thoughtSignature;
          logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] ✅ 为带图片 assistant 消息附加 thoughtSignature，消息ID:', msg.id);
        } else if (msgRole === 'assistant' && msg.metadata?.gemini?.thoughtSignature && !isGemini) {
          logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] ⚠️ 跳过附加 thoughtSignature（非 Gemini 模型），消息ID:', msg.id);
        }

        structuredMessages.push({
          role: msgRole,
          content: messageParts
        });

        if (msg.id) {
          messageNumberMap.set(currentNumber, msg.id);
        }
        currentNumber++;
      } else {
        // ❌ 不发送图片：按文本消息处理，显示为 [图片]描述
        const description = msg.description || '';
        messageContent = `[图片]${description || '无描述'}`;

        // 根据 sender 累积到对应 buffer（和普通文本消息一样）
        if (msg.sender === 'contact') {
          // contact 消息 → 累积到轮次 buffer
          if (!inContactTurn) {
            // 新轮次开始，先 flush textBuffer
            if (textBuffer.trim() !== `[角色-${contact.name}]\n[消息]`.trim()) {
              structuredMessages.push({ role: 'system', content: textBuffer });
              textBuffer = `[角色-${contact.name}]\n[消息]\n`;
            }
            inContactTurn = true;
            turnStartNumber = currentNumber;
          }

          // 累积消息文本
          if (msg.id) {
            messageNumberMap.set(currentNumber, msg.id);
            turnBuffer += `[#${currentNumber}] ${timeStr}${senderName}: ${messageContent}\n`;
          } else {
            turnBuffer += `${timeStr}${senderName}: ${messageContent}\n`;
          }

          // 提取签名（只在第一条消息）
          if (!turnSignature && msg.metadata?.gemini?.thoughtSignature) {
            turnSignature = msg.metadata.gemini.thoughtSignature;
            logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] 🔍 提取轮次签名，消息ID:', msg.id);
          }

          currentNumber++;
        } else {
          // user 消息 → 先 flush contact 轮次，再累积到 textBuffer
          flushContactTurn();

          // 累积到 textBuffer
          if (msg.id) {
            messageNumberMap.set(currentNumber, msg.id);
            textBuffer += `[#${currentNumber}] ${timeStr}${senderName}: ${messageContent}\n`;
            currentNumber++;
          } else {
            textBuffer += `${timeStr}${senderName}: ${messageContent}\n`;
          }
        }
      }

    } else if (msg.sender === 'contact') {
      // 🔥 纯文本 contact 消息 → 累积到轮次 buffer
      if (!inContactTurn) {
        // 新轮次开始，先 flush textBuffer
        if (textBuffer.trim() !== `[角色-${contact.name}]\n[消息]`.trim()) {
          structuredMessages.push({ role: 'system', content: textBuffer });
          textBuffer = `[角色-${contact.name}]\n[消息]\n`;
        }
        inContactTurn = true;
        turnStartNumber = currentNumber;
      }

      // 累积消息文本
      if (msg.id) {
        messageNumberMap.set(currentNumber, msg.id);
        turnBuffer += `[#${currentNumber}] ${timeStr}${senderName}: ${messageContent}\n`;
      } else {
        turnBuffer += `${timeStr}${senderName}: ${messageContent}\n`;
      }

      // 提取签名（只在第一条消息）
      if (!turnSignature && msg.metadata?.gemini?.thoughtSignature) {
        turnSignature = msg.metadata.gemini.thoughtSignature;
        logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] 🔍 提取轮次签名，消息ID:', msg.id);
      }

      currentNumber++;

    } else {
      // 🔥 user 消息 → 先 flush contact 轮次，再累积到 textBuffer
      flushContactTurn();

      // 累积到 textBuffer
      if (msg.id) {
        messageNumberMap.set(currentNumber, msg.id);
        textBuffer += `[#${currentNumber}] ${timeStr}${senderName}: ${messageContent}\n`;
        currentNumber++;
      } else {
        textBuffer += `${timeStr}${senderName}: ${messageContent}\n`;
      }
    }
  }

  // ✅ 循环结束，flush 最后的 contact 轮次
  flushContactTurn();

  // ✅ flush 最后的文本块 + 添加结束标记
  textBuffer += `----上方对话user已读-----\n[/消息]\n[/角色-${contact.name}]`;
  structuredMessages.push({ role: 'system', content: textBuffer });

  logger.info('phone','[ContextBuilder.buildChatHistoryStructured] 结构化消息构建完成');
  logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] - 消息数量:', structuredMessages.length);
  logger.debug('phone','[ContextBuilder.buildChatHistoryStructured] - 历史图片数量:', historyImages.length);

  return {
    structuredMessages,
    nextNumber: currentNumber,
    historyImages
  };
}

/**
 * 构建聊天记录内容（最新消息，用于[QQ聊天记录]）
 *
 * @private
 * @param {string} contactId - 联系人ID
 * @param {Object} contact - 联系人对象
 * @param {Map} messageNumberMap - 消息编号映射表（编号→消息ID）
 * @param {number} [startNumber=1] - 起始编号
 * @param {string} [apiSource='default'] - API配置源（'default'=酒馆API只支持纯文本, 'custom'=自定义API支持多模态数组）
 * @param {Array} [imagesToAttach=[]] - 待附加的图片列表（待发送消息中的图片）
 * @returns {Promise<Object>} { parts: 结构化内容数组, nextNumber: 下一个可用编号, historyImages: 历史消息中需要重新发送的图片列表 }
 *
 * @description
 * 返回结构化数组，包含文本片段和图片占位符：
 * - { type: 'text', text: '...' } - 文本片段
 * - { type: 'image_placeholder', messageId: 'xxx' } - 图片占位符
 *
 * 只包含最新的recentCount条消息（不包括excluded的）
 * 优化规则：
 * 1. 临时编号：每条消息加 [#N] 前缀（用于AI引用）
 * 2. 时间智能分组（跨天显示日期，同天只显示时间）
 * 3. 表情消息添加 [表情] 前缀
 * 4. 用户名使用真实姓名（不用"你"）
 *
 * ⚠️ 注意：此函数只返回历史记录，不包含待发送消息（待发送消息由 buildUserPendingOps 处理）
 */
export async function buildChatHistoryInfo(contactId, contact, messageNumberMap, startNumber = 1, apiSource = 'default', imagesToAttach = []) {
  // 动态导入工具函数
  const { formatTimeForAI } = await import('../utils/time-helper.js');
  const { getUserDisplayName } = await import('../utils/contact-display-helper.js');
  const { findEmojiById } = await import('../emojis/emoji-manager-data.js');
  const { getChatSendSettings } = await import('../messages/message-chat-data.js');

  const userName = getUserDisplayName();
  const sendSettings = getChatSendSettings(contactId);

  // ✅ 获取图片识别模式
  const imageMode = extension_settings.acsusStandalonePhone?.phone?.imageMode || 'once';
  logger.debug('phone','[ContextBuilder.buildChatHistoryInfo] imageMode:', imageMode);

  // ✅ 获取当前轮次（用于排除当前轮次的图片，避免重复）
  const { getCurrentRound } = await import('../messages/message-chat-data.js');
  const currentRound = await getCurrentRound(contactId);
  logger.debug('phone','[ContextBuilder.buildChatHistoryInfo] currentRound:', currentRound);
  logger.info('phone','[ContextBuilder.buildChatHistoryInfo] API配置源:', apiSource, apiSource === 'custom' ? '（使用结构化消息）' : '（使用纯文本）');

  // ✅ 根据 API 配置源选择返回格式
  if (apiSource === 'custom') {
    // 🔥 自定义API：返回结构化消息数组（带图片的消息拆分成独立 role）
    return await buildChatHistoryStructured(contactId, contact, messageNumberMap, startNumber, currentRound, sendSettings, userName, apiSource);
  }

  // ✅ 默认API：返回 parts 数组（保持原有逻辑）
  let parts = [];
  let historyImages = [];  // 收集历史消息中需要附加的图片
  parts.push({ type: 'text', text: `[角色-${contact.name}]\n[消息]\n` });

  // 加载历史记录
  const allHistory = await loadChatHistory(contactId);

  // 过滤出非排除的消息，取最新的recentCount条
  const validHistory = allHistory.filter(msg => !msg.excluded);
  const recentHistory = validHistory.slice(Math.max(0, validHistory.length - sendSettings.recentCount));

  let currentNumber = startNumber;

  if (recentHistory.length > 0) {
    // ✅ 改用 for 循环，支持在消息间插入图片占位符
    for (let index = 0; index < recentHistory.length; index++) {
      const msg = recentHistory[index];
      const senderName = msg.sender === 'user' ? userName : contact.name;
      const prevTime = index > 0 ? recentHistory[index - 1].time : null;
      const isFirst = index === 0;

      // 智能时间显示（跨天显示日期，同天显示时间）
      const timeStr = formatTimeForAI(msg.time, prevTime, isFirst);

      // 根据消息类型添加前缀
      let messageContent = msg.content;
      let messagePrefix = '';

      if (msg.type === 'poke') {
        // 戳一戳消息
        messageContent = '[戳一戳]';
      } else if (msg.type === 'emoji') {
        // ✅ 通过ID查找表情包名称（支持改名）
        const emoji = findEmojiById(msg.content);
        if (emoji) {
          messageContent = `[表情]${emoji.name}`;
        } else {
          // 表情包被删除，使用冗余存储的名字
          messageContent = msg.emojiName ? `[表情]${msg.emojiName}` : `[表情包已删除]`;
        }
      } else if (msg.type === 'image-real') {
        // ✅ 真实图片（新类型）：在聊天记录中显示[图片]标记
        const description = msg.description || '';
        messageContent = description ? `[图片]${description}` : '[图片]';

        // imageMode = 'always' 时，历史图片也要重新发送给AI
        // ✅ 排除当前轮次的图片（当前轮次的图片由 buildUserPendingOps 处理）
        if (imageMode === 'always' && msg.imageUrl && msg.imageRound !== currentRound) {
          historyImages.push({
            url: msg.imageUrl,
            contactId: contactId,
            messageId: msg.id,
            round: msg.imageRound
          });
          logger.debug('phone','[ContextBuilder.buildChatHistoryInfo] 🖼️ 历史真实图片将重新发送 (imageMode=always):', msg.id, '轮次:', msg.imageRound);
        } else if (imageMode === 'always' && msg.imageUrl && msg.imageRound === currentRound) {
          logger.debug('phone','[ContextBuilder.buildChatHistoryInfo] ⏭️ 跳过当前轮次的图片（由待发送消息处理）:', msg.id, '轮次:', msg.imageRound);
        }
      } else if (msg.type === 'image-fake') {
        // ✅ 假装图片（新类型）：显示 [图片]描述
        messageContent = `[图片]${msg.description || '无描述'}`;
      } else if (msg.type === 'image') {
        // ✅ 旧数据兼容：根据 imageUrl 判断类型
        if (msg.imageUrl) {
          // 真实图片：在聊天记录中显示[图片]标记
          const description = msg.description || '';
          messageContent = description ? `[图片]${description}` : '[图片]';

          // imageMode = 'always' 时，历史图片也要重新发送给AI
          // ✅ 排除当前轮次的图片（当前轮次的图片由 buildUserPendingOps 处理）
          if (imageMode === 'always' && msg.imageRound !== currentRound) {
            historyImages.push({
              url: msg.imageUrl,
              contactId: contactId,
              messageId: msg.id,
              round: msg.imageRound
            });
            logger.debug('phone','[ContextBuilder.buildChatHistoryInfo] 🖼️ 历史真实图片将重新发送 (imageMode=always, 旧数据):', msg.id, '轮次:', msg.imageRound);
          } else if (imageMode === 'always' && msg.imageRound === currentRound) {
            logger.debug('phone','[ContextBuilder.buildChatHistoryInfo] ⏭️ 跳过当前轮次的图片（由待发送消息处理, 旧数据）:', msg.id, '轮次:', msg.imageRound);
          }
        } else {
          // 假装图片：显示 [图片]描述
          messageContent = `[图片]${msg.description || '无描述'}`;
        }
      } else if (msg.type === 'quote') {
        // 引用消息：格式化为 [引用]原内容[回复]回复内容
        const quotedText = formatQuotedMessageForAI(msg.quotedMessage);
        messageContent = `[引用]${quotedText}[回复]${msg.replyContent}`;
      } else if (msg.type === 'transfer') {
        // 转账消息：格式化为 [转账]金额元 留言内容
        messageContent = msg.message
          ? `[转账]${msg.amount}元 ${msg.message}`
          : `[转账]${msg.amount}元`;
      } else if (msg.type === 'gift-membership') {
        // 会员送礼消息：格式化为 [送会员]X个月VIP/SVIP会员
        const typeText = msg.membershipType === 'vip' ? 'VIP' : 'SVIP';
        messageContent = `[送会员]${msg.months}个月${typeText}会员`;
      } else if (msg.type === 'buy-membership') {
        // 角色买会员消息：格式化为 [开会员]X个月VIP/SVIP会员
        const typeText = msg.membershipType === 'vip' ? 'VIP' : 'SVIP';
        messageContent = `[开会员]${msg.months}个月${typeText}会员`;
      } else if (msg.type === 'recalled') {
        // 撤回消息：根据发送者显示不同内容
        if (msg.sender === 'user') {
          // 用户撤回：AI只看到"撤回了一条消息"，看不到原内容
          messageContent = `【${userName}撤回了一条消息】`;
        } else {
          // 角色撤回：AI可以看到撤回了什么（格式：[撤回]原内容）
          messageContent = `[撤回]${msg.originalContent || '(无内容)'}`;
        }
      } else if (msg.type === 'forwarded') {
        // 转发消息：格式化内层消息，添加时间戳
        messageContent = formatForwardedMessageForAI(msg, userName, formatTimeForAI);
      }

      // 如果消息来自收藏，添加[收藏夹]前缀和原消息信息（同一行）
      if (msg.fromFavorite) {
        const originalTime = msg.favoriteOriginalTime || msg.time;
        const originalTimeStr = formatTimeForAI(originalTime, null, true);
        const originalSender = msg.favoriteOriginalSender || senderName;
        // 去掉 originalTimeStr 末尾的换行符，保持在同一行
        const cleanTimeStr = originalTimeStr.replace(/\n$/, '');
        messagePrefix = `[收藏夹] ${cleanTimeStr}${originalSender}: `;
      }

      // ✅ 添加临时编号 + 保存映射
      if (msg.id) {
        messageNumberMap.set(currentNumber, msg.id);
        parts.push({
          type: 'text',
          text: `[#${currentNumber}] ${timeStr}${senderName}: ${messagePrefix}${messageContent}`
        });
        currentNumber++;

        // ✅ 检查是否有图片需要附加到这条消息（包括历史图片和待发送图片）
        const hasPendingImage = imagesToAttach.find(img => img.messageId === msg.id);
        const hasHistoryImage = historyImages.find(img => img.messageId === msg.id);

        if (hasPendingImage || hasHistoryImage) {
          parts.push({
            type: 'image_placeholder',
            messageId: msg.id
          });
          logger.debug('phone','[ContextBuilder.buildChatHistoryInfo] 📍 在消息后插入图片占位符:', msg.id);
        }

        parts.push({ type: 'text', text: '\n' });
      } else {
        // 旧数据兼容：没有ID的消息不加编号
        parts.push({
          type: 'text',
          text: `${timeStr}${senderName}: ${messagePrefix}${messageContent}\n`
        });
      }
    }

    // 添加已读标记
    parts.push({ type: 'text', text: '----上方对话user已读-----\n' });
  }

  // ✅ 改用 [/消息] [/角色-XXX] 格式
  parts.push({ type: 'text', text: `[/消息]\n[/角色-${contact.name}]` });

  logger.info('phone','[ContextBuilder.buildChatHistoryInfo] 聊天历史构建完成');
  logger.debug('phone','[ContextBuilder.buildChatHistoryInfo] - parts数量:', parts.length);
  logger.debug('phone','[ContextBuilder.buildChatHistoryInfo] - 历史图片数量:', historyImages.length);

  return {
    parts,  // ← 返回结构化数组
    nextNumber: currentNumber,
    historyImages  // ← 返回历史图片列表（imageMode='always'时有值）
  };
}

/**
 * 格式化引用消息（用于AI上下文）
 *
 * @private
 * @param {Object} quotedMessage - 被引用的消息
 * @returns {string} 格式化后的文本
 */
function formatQuotedMessageForAI(quotedMessage) {
  if (!quotedMessage) return '未知消息';

  switch (quotedMessage.type) {
    case 'text':
      return quotedMessage.content || '[空文本]';
    case 'emoji':
      return `[表情]${quotedMessage.content || quotedMessage.emojiName || '未知'}`;
    case 'image':
      return `[图片]${quotedMessage.description || '无描述'}`;
    case 'quote':
      // 引用的引用：只引用回复部分，不嵌套
      return quotedMessage.replyContent || '[空回复]';
    default:
      return '[不支持的类型]';
  }
}

/**
 * 格式化转发消息（用于AI上下文）
 *
 * @private
 * @param {Object} forwardedMsg - 转发消息对象
 * @param {string} userName - 用户显示名称
 * @param {Function} formatTimeForAI - 时间格式化函数
 * @returns {string} 格式化后的内容
 *
 * @description
 * 格式化转发消息，外层只显示 [转发消息]，内层显示完整聊天记录：
 * - 外层：[转发消息]
 * - 内层：带时间戳的消息列表（支持跨天显示日期）
 * - 内层消息不添加临时编号
 *
 * @example
 * 输出格式：
 * [转发消息]
 * [白沉与鬼面的聊天记录]
 * [2025-11-16]
 * [14:30] 白沉: 下午好
 * [14:31] 鬼面: 下午好，白沉 :)
 * [/白沉与鬼面的聊天记录]
 * [/转发消息]
 */
function formatForwardedMessageForAI(forwardedMsg, userName, formatTimeForAI) {
  if (!forwardedMsg.messages || forwardedMsg.messages.length === 0) {
    return '[转发消息]\n[空聊天记录]\n[/空聊天记录]\n[/转发消息]';
  }

  // 构建标题
  const originalContactName = forwardedMsg.originalContactName || '未知联系人';
  let content = `[转发消息]\n[${userName}与${originalContactName}的聊天记录]\n`;

  // 遍历内层消息，添加时间戳
  forwardedMsg.messages.forEach((innerMsg, index) => {
    // 替换 {{user}} 为实际用户名
    let senderName = innerMsg.senderName;
    if (senderName === '{{user}}') {
      senderName = userName;
    }

    // 获取时间戳（智能分组：跨天显示日期，同天只显示时间）
    const prevTime = index > 0 ? forwardedMsg.messages[index - 1].time : null;
    const isFirst = index === 0;
    const timeStr = formatTimeForAI(innerMsg.time, prevTime, isFirst);

    // 获取消息内容
    let messageText = '';
    switch (innerMsg.type) {
      case 'text':
        messageText = innerMsg.content || '';
        break;
      case 'emoji':
        messageText = `[表情]${innerMsg.emojiName || ''}`;
        break;
      case 'image':
        messageText = `[图片]${innerMsg.description || ''}`;
        break;
      case 'quote':
        messageText = `[引用]${innerMsg.replyContent || ''}`;
        break;
      case 'transfer':
        messageText = `[转账]${innerMsg.amount || '0'}元`;
        break;
      case 'redpacket':
        messageText = `[红包]${innerMsg.amount || '0'}元`;
        break;
      case 'video':
        messageText = `[视频]${innerMsg.description || ''}`;
        break;
      case 'file':
        messageText = `[文件]${innerMsg.filename || ''}`;
        break;
      case 'recalled':
        messageText = '[撤回的消息]';
        break;
      case 'poke':
        messageText = '[戳一戳]';
        break;
      default:
        messageText = innerMsg.content || '[未知消息]';
    }

    // 添加消息（不加临时编号）
    content += `${timeStr}${senderName}: ${messageText}\n`;
  });

  content += `[/${userName}与${originalContactName}的聊天记录]\n[/转发消息]`;
  return content;
}

/**
 * 构建用户个签历史（用于[个签历史]）
 *
 * @async
 * @private
 * @returns {Promise<string>} 个签历史内容
 *
 * @description
 * 格式：
 * [用户个签历史]
 * 2025-11-08 17:30 - 今天心情不错～
 * 2025-11-07 20:15 - 明天见！
 * 2025-11-06 15:00 - 忙碌的一天
 * [/用户个签历史]
 */
async function buildSignatureHistory() {
  try {
    const { getUserSignatureTop3 } = await import('../profile/signature-data.js');
    const { getUserDisplayName } = await import('../utils/contact-display-helper.js');

    const userName = getUserDisplayName();
    const history = await getUserSignatureTop3();

    if (!history || history.length === 0) {
      return ''; // 没有历史记录时返回空
    }

    let content = `[用户个签历史]\n`;

    history.forEach(item => {
      const date = new Date(item.timestamp * 1000);  // 秒级时间戳转毫秒级
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      content += `${dateStr} ${timeStr} - ${item.content}\n`;
    });

    content += `[/用户个签历史]`;

    logger.debug('phone','[ContextBuilder] 个签历史已构建，共', history.length, '条');
    return content;
  } catch (error) {
    logger.error('phone','[ContextBuilder] 构建个签历史失败:', error);
    return '';
  }
}

/**
 * 构建用户待操作内容（用于[{{user}}本轮操作]）
 *
 * @private
 * @param {Object} pendingMessages - 所有待发送消息（按联系人分组）
 * @param {Map<number, string>} messageNumberMap - 消息编号映射表
 * @param {number} startNumber - 起始编号
 * @returns {Promise<Object>} { content: 用户待操作内容, nextNumber: 下一个可用编号, imagesToAttach: 筛选后要附加的图片列表 }
 *
 * @description
 * 格式：
 * #提醒：需关注{{user}}本轮操作
 * [{{user}}本轮操作]
 * [给Jerry Hickfang发送消息]
 * [#3] [21:43] 白沉: [表情]企鹅震惊
 * [#4] [21:44] 白沉: 你好
 * [#5] [21:45] 白沉: [约定计划]一起去吃卷饼
 *
 * [给李四发送消息]
 * [#6] [21:45] 白沉: 在吗
 *
 * [/{{user}}本轮操作]
 *
 * ✅ 支持的消息类型：
 * - text: 普通文本
 * - poke: 戳一戳
 * - emoji: 表情包
 * - image-real: 真实图片（AI识别）
 * - image-fake: 假装图片（AI过家家）
 * - transfer: 转账
 * - gift-membership: 送会员
 * - buy-membership: 开会员
 * - quote: 引用消息
 * - forwarded: 转发消息
 * - recalled: 撤回消息
 * - plan: 约定计划（支持 type='plan' 或 type='text' 格式）
 *
 * ✅ 图片识别机制（2025-11-16新增）：
 * - 根据 imageMode 设置筛选要发送给AI的图片
 * - 'once': 只发送本轮（imageRound = currentRound）的图片
 * - 'always': 发送所有图片
 * - 'never': 不发送任何图片
 * - 返回 imagesToAttach 数组供调用方附加到Message对象
 */
async function buildUserPendingOps(pendingMessages, messageNumberMap, startNumber = 1) {
  // 动态导入工具函数
  const { formatTimeForAI } = await import('../utils/time-helper.js');
  const { getUserDisplayName } = await import('../utils/contact-display-helper.js');
  const { findEmojiById } = await import('../emojis/emoji-manager-data.js');
  const { loadContacts } = await import('../contacts/contact-list-data.js');

  const userName = getUserDisplayName();

  // 如果没有待操作，返回空对象
  if (!pendingMessages || Object.keys(pendingMessages).length === 0) {
    logger.debug('phone','[ContextBuilder.buildUserPendingOps] 没有待发送消息，返回空内容');
    return {
      content: '',
      nextNumber: startNumber,
      imagesToAttach: []  // ✅ 新增：返回空图片数组
    };
  }

  // ✅ 获取图片识别模式设置
  const imageMode = extension_settings.acsusStandalonePhone?.phone?.imageMode || 'once';
  logger.info('phone','[ContextBuilder.buildUserPendingOps] 图片识别模式:', imageMode);

  // ✅ 收集所有待发送的图片消息（用于后续附加到Message对象）
  const imagesToAttach = [];

  // 开始构建
  let content = `#提醒：需关注{{user}}本轮操作\n`;
  content += `[{{user}}本轮操作]\n`;

  // 加载所有联系人（用于获取角色名）
  const contacts = await loadContacts();

  let currentNumber = startNumber;

  // 遍历所有联系人的待发送消息
  for (const [contactId, messages] of Object.entries(pendingMessages)) {
    if (messages.length === 0) continue;

    // 查找联系人信息
    const contact = contacts.find(c => c.id === contactId);
    const contactName = contact ? contact.name : contactId;

    // 添加联系人分组标题
    content += `[给${contactName}发送消息]\n`;

    // 遍历该联系人的所有待发送消息（✅ 改用for循环以支持async/await）
    for (let index = 0; index < messages.length; index++) {
      const msg = messages[index];

      // 判断是否需要显示日期分组
      const prevTime = index > 0 ? messages[index - 1].time : null;
      const isFirst = index === 0;
      const timeStr = formatTimeForAI(msg.time, prevTime, isFirst);

      // 根据消息类型添加前缀
      let messageContent = msg.content;
      if (msg.type === 'poke') {
        // 戳一戳消息
        messageContent = '[戳一戳]';
      } else if (msg.type === 'emoji') {
        // ✅ 通过ID查找表情包名称（支持改名）
        const emoji = findEmojiById(msg.content);
        if (emoji) {
          messageContent = `[表情]${emoji.name}`;
        } else {
          // 表情包被删除，使用冗余存储的名字
          messageContent = msg.emojiName ? `[表情]${msg.emojiName}` : `[表情包已删除]`;
        }
      } else if (msg.type === 'image-real') {
        // ✅ 类型1：真实图片（AI识别）
        logger.info('phone','[ContextBuilder.buildUserPendingOps] 🖼️ 检测到真实图片消息');
        logger.info('phone','[ContextBuilder.buildUserPendingOps]   - 联系人:', contactId);
        logger.info('phone','[ContextBuilder.buildUserPendingOps]   - 消息ID:', msg.id);
        logger.info('phone','[ContextBuilder.buildUserPendingOps]   - 图片URL:', msg.imageUrl);
        logger.info('phone','[ContextBuilder.buildUserPendingOps]   - 图片描述:', msg.description || '无');
        logger.info('phone','[ContextBuilder.buildUserPendingOps]   - 图片轮次(imageRound):', msg.imageRound);
        logger.info('phone','[ContextBuilder.buildUserPendingOps]   - imageMode设置:', imageMode);

        const description = msg.description || '';

        // 判断是否发送给AI
        if (imageMode === 'never') {
          // 不发送给AI，显示为假装图片
          messageContent = `[图片]${description || '无描述'}`;
          logger.info('phone','[ContextBuilder.buildUserPendingOps] 📵 imageMode=never，真实图片按假装图片处理');
        } else {
          // 获取当前轮次（用于判断是否发送）
          const { getCurrentRound } = await import('../messages/message-chat-data.js');
          const currentRound = await getCurrentRound(contactId);
          logger.info('phone','[ContextBuilder.buildUserPendingOps]   - 当前轮次(currentRound):', currentRound);

          // 判断是否应该发送这张图片
          let shouldInclude = false;
          if (imageMode === 'always') {
            shouldInclude = true;
            logger.info('phone','[ContextBuilder.buildUserPendingOps] ✅ imageMode=always，包含图片:', msg.imageUrl);
          } else if (imageMode === 'once') {
            if (msg.imageRound === currentRound) {
              shouldInclude = true;
              logger.info('phone','[ContextBuilder.buildUserPendingOps] ✅ imageMode=once，图片属于当前轮次，包含:', msg.imageUrl);
              logger.info('phone','[ContextBuilder.buildUserPendingOps]   - 图片轮次:', msg.imageRound, '= 当前轮次:', currentRound);
            } else {
              logger.warn('phone','[ContextBuilder.buildUserPendingOps] ⏭️ imageMode=once，图片不属于当前轮次，跳过');
              logger.warn('phone','[ContextBuilder.buildUserPendingOps]   - 图片轮次:', msg.imageRound, '≠ 当前轮次:', currentRound);
            }
          }

          // 收集要附加的图片
          if (shouldInclude) {
            imagesToAttach.push({
              url: msg.imageUrl,
              contactId: contactId,
              messageId: msg.id,
              round: msg.imageRound
            });
            // ✅ 真实图片：只显示描述文本（Message.addImage()会添加图片）
            // 如果没有描述，保留为空字符串（Message.addImage()会正确处理）
            messageContent = description || '';  // 空描述：空字符串，有描述：显示描述
            logger.info('phone','[ContextBuilder.buildUserPendingOps] ✅ 已收集待附加图片:', msg.imageUrl);
            logger.info('phone','[ContextBuilder.buildUserPendingOps]   - 消息文本内容:', messageContent || '（空字符串）');
            logger.info('phone','[ContextBuilder.buildUserPendingOps]   - imagesToAttach数组长度:', imagesToAttach.length);
          } else {
            // 不发送给AI，显示为假装图片
            messageContent = `[图片]${description || '无描述'}`;
            logger.warn('phone','[ContextBuilder.buildUserPendingOps] ⏭️ 图片不符合收集条件，按假装图片处理');
          }
        }
      } else if (msg.type === 'image-fake') {
        // ✅ 类型2/3：假装图片（AI过家家）
        logger.info('phone','[ContextBuilder.buildUserPendingOps] 📝 检测到假装图片消息');
        logger.info('phone','[ContextBuilder.buildUserPendingOps]   - 联系人:', contactId);
        logger.info('phone','[ContextBuilder.buildUserPendingOps]   - 消息ID:', msg.id);
        logger.info('phone','[ContextBuilder.buildUserPendingOps]   - 图片描述:', msg.description);

        // 假装图片：显示为文本格式
        messageContent = `[图片]${msg.description || '无描述'}`;
      } else if (msg.type === 'transfer') {
        // ✅ 转账消息：格式化为 [转账]金额元 留言内容
        messageContent = msg.message
          ? `[转账]${msg.amount}元 ${msg.message}`
          : `[转账]${msg.amount}元`;
      } else if (msg.type === 'gift-membership') {
        // ✅ 会员送礼消息：格式化为 [送会员]X个月VIP/SVIP会员
        const typeText = msg.membershipType === 'vip' ? 'VIP' : 'SVIP';
        messageContent = `[送会员]${msg.months}个月${typeText}会员`;
      } else if (msg.type === 'buy-membership') {
        // ✅ 角色买会员消息：格式化为 [开会员]X个月VIP/SVIP会员
        const typeText = msg.membershipType === 'vip' ? 'VIP' : 'SVIP';
        messageContent = `[开会员]${msg.months}个月${typeText}会员`;
      } else if (msg.type === 'quote') {
        // ✅ 引用消息：格式化为 [引用]原内容[回复]回复内容
        const quotedText = formatQuotedMessageForAI(msg.quotedMessage);
        messageContent = `[引用]${quotedText}[回复]${msg.replyContent}`;
      } else if (msg.type === 'forwarded') {
        // ✅ 转发消息：格式化内层消息
        messageContent = formatForwardedMessageForAI(msg, userName, formatTimeForAI);
      } else if (msg.type === 'recalled') {
        // 撤回消息：用户撤回只显示"撤回了一条消息"（AI看不到原内容）
        messageContent = `【${userName}撤回了一条消息】`;
      } else if (msg.type === 'plan' || (msg.type === 'text' && msg.content?.startsWith('[约定计划'))) {
        // ✅ 约定计划消息：支持 type='plan' 或 type='text' 格式
        // 保持原格式，AI会识别
        messageContent = msg.content;
      }

      // ✅ 处理日期分组和消息编号
      if (msg.id) {
        messageNumberMap.set(currentNumber, msg.id);

        // 检查时间格式是否包含换行（跨天分组）
        if (timeStr.endsWith('\n')) {
          // 跨天：先输出日期分组（不带编号），再输出消息（带编号和时间）
          const date = new Date(msg.time * 1000);
          const hour = String(date.getHours()).padStart(2, '0');
          const minute = String(date.getMinutes()).padStart(2, '0');
          content += timeStr; // 日期分组：[2025-11-05]\n
          content += `[#${currentNumber}] [${hour}:${minute}] ${userName}: ${messageContent}\n`;
        } else {
          // 同一天：正常格式
          content += `[#${currentNumber}] ${timeStr}${userName}: ${messageContent}\n`;
        }
        currentNumber++;
      } else {
        content += `${timeStr}${userName}: ${messageContent}\n`;
      }
    }

    // 添加空行分隔不同联系人
    content += '\n';
  }

  // 检查当前联系人是否有已完成但未输出剧情的计划
  // 注意：这里检查的是所有联系人的计划，不局限于 pendingMessages
  const { getCompletedPlans, updatePlanStatus } = await import('../plans/plan-data.js');

  // 只检查当前正在发送消息的联系人
  for (const [contactId, messages] of Object.entries(pendingMessages)) {
    const completedPlans = getCompletedPlans(contactId);

    // 查找已完成但未输出剧情的计划（通过 status 判断）
    const pendingStoryPlans = completedPlans.filter(p =>
      p.diceResult && p.status === 'completed' && !p.storyGenerated
    );

    if (pendingStoryPlans.length > 0) {
      // 只处理最新的一个计划（避免一次输出太多）
      const plan = pendingStoryPlans[pendingStoryPlans.length - 1];

      content += `\n[临时任务]\n`;
      content += `任务类型：约定计划执行\n`;
      content += `计划内容：${plan.title}\n`;
      content += `骰子结果：${plan.diceResult}/100 - ${plan.outcome}\n`;
      content += `剧情提示：${plan.story}\n\n`;

      content += `请按以下格式输出：\n\n`;
      content += `[约定计划过程]请根据计划内容，结合骰子结果和剧情提示，用50-200字左右描述过程，禁止换行。\n\n`;

      if (plan.options?.includeInnerThought) {
        content += `[约定计划内心印象]请描述角色对这次经历的内心感受（50-100字），禁止换行。\n\n`;
      }

      if (plan.options?.includeRecord) {
        content += `[约定计划过程记录]请简要记录这次经历的关键事件（30-50字），禁止换行。\n\n`;
      }

      content += `必须在角色的[消息]标签之后输出这些格式,输出后再正常发送对话消息\n`;
      content += `注意：是[消息]的标签之后，而不是发完对话消息后再输出，先在[消息]之后输出这些内容\n`;
      content += `[/临时任务]\n`;

      // 标记该计划已生成剧情提示（避免重复生成）
      const { updatePlanStoryGenerated } = await import('../plans/plan-data.js');
      updatePlanStoryGenerated(contactId, plan.id, true);
    }
  }

  // 添加个签操作记录
  const { getSignatureActions } = await import('./pending-operations.js');
  const signatureActions = getSignatureActions();

  if (signatureActions.length > 0) {
    content += `\n[其他操作]\n`;

    for (const action of signatureActions) {
      const time = formatTimeForAI(action.time, null, false);

      if (action.actionType === 'update') {
        // 用户修改自己的个签
        content += `${time}${userName}修改了个性签名：${action.signature}\n`;
      } else if (action.actionType === 'like') {
        // 用户点赞角色的个签
        content += `${time}${userName}点赞了${action.contactName}的个性签名\n`;
      } else if (action.actionType === 'comment') {
        // 用户评论角色的个签
        content += `${time}${userName}评论了${action.contactName}的个性签名：${action.comment}\n`;
      }
    }

    content += `[/其他操作]\n`;
  }

  // ✅ 检查AI感知删除的角色，根据概率触发好友申请
  const triggeredRequests = await checkAndTriggerAIAwareReapply();
  if (triggeredRequests.length > 0) {
    logger.info('phone','[ContextBuilder.buildUserPendingOperations] 检测到', triggeredRequests.length, '个AI感知删除触发');

    // 构建临时任务内容（只包含提示词，不包含角色信息）
    content += `\n[临时任务]\n`;
    content += `任务类型：AI感知删除的好友申请\n`;
    content += `说明：以下角色在被删除后想要重新申请加为好友\n\n`;

    // 添加每个角色的删除通知
    for (const request of triggeredRequests) {
      // 格式化删除时间
      const deleteDate = new Date(request.deleteTime * 1000);
      const dateStr = `${deleteDate.getFullYear()}-${String(deleteDate.getMonth() + 1).padStart(2, '0')}-${String(deleteDate.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(deleteDate.getHours()).padStart(2, '0')}:${String(deleteDate.getMinutes()).padStart(2, '0')}`;

      content += `[角色-${request.contactName}]\n`;
      content += `${userName}于${dateStr} ${timeStr}删除了你的好友\n`;
      content += `[/角色-${request.contactName}]\n\n`;
    }

    // 添加好友申请格式说明和示例
    content += `[好友申请格式说明]\n`;
    content += `你可以在回复中使用以下格式重新申请加好友：\n\n`;
    content += `[好友申请]附加消息内容\n\n`;
    content += `示例：\n`;
    content += `[角色-角色名]\n`;
    content += `[消息]\n`;
    content += `[好友申请]消息1\n`;
    content += `消息2\n`;
    content += `可以换行来表示发了几条申请消息，无需重复输出[好友申请]标签\n`;
    content += `[/好友申请格式说明]\n\n`;

    content += `注意：\n`;
    content += `1. [好友申请]标签必须在[消息]标签内部，后面直接跟申请消息内容\n`;
    content += `2. [好友申请]时无法发送特殊消息(如[戳一戳]、[表情]、[图片]等)，仅能发送普通文字消息\n`;
    content += `3. 可以选择申请或不申请，根据角色性格和剧情决定\n`;
    content += `4. 申请消息应该符合角色性格和当前情境\n`;
    content += `[/临时任务]\n`;

    logger.info('phone','[ContextBuilder.buildUserPendingOperations] AI感知删除通知已添加到临时任务');
  }

  content += `[/{{user}}本轮操作]`;

  // ✅ 日志输出筛选结果
  logger.info('phone','[ContextBuilder.buildUserPendingOps] ========== 用户待操作构建完成 ==========');
  logger.info('phone','[ContextBuilder.buildUserPendingOps] 消息编号范围:', startNumber, '~', currentNumber - 1);
  logger.info('phone','[ContextBuilder.buildUserPendingOps] 📊 筛选后待附加图片数量:', imagesToAttach.length);
  if (imagesToAttach.length > 0) {
    logger.info('phone','[ContextBuilder.buildUserPendingOps] 📋 待附加图片列表:');
    imagesToAttach.forEach((img, index) => {
      logger.info('phone',`[ContextBuilder.buildUserPendingOps]   ${index + 1}. ${img.url} (轮次${img.round}, 联系人:${img.contactId})`);
    });
  } else {
    logger.warn('phone','[ContextBuilder.buildUserPendingOps] ⚠️ 没有收集到任何待附加图片');
    logger.warn('phone','[ContextBuilder.buildUserPendingOps]   - 可能原因1：没有图片消息（msg.type !== "image"）');
    logger.warn('phone','[ContextBuilder.buildUserPendingOps]   - 可能原因2：图片消息缺少imageUrl字段');
    logger.warn('phone','[ContextBuilder.buildUserPendingOps]   - 可能原因3：imageMode="never"');
    logger.warn('phone','[ContextBuilder.buildUserPendingOps]   - 可能原因4：imageMode="once"但图片不属于当前轮次');
  }

  return {
    content,
    nextNumber: currentNumber,
    imagesToAttach  // ✅ 新增：返回筛选后的图片列表
  };
}

/**
 * 构建历史聊天记录内容（用于[历史聊天记录]）
 *
 * @private
 * @param {string} contactId - 联系人ID
 * @param {Object} contact - 联系人对象
 * @param {Map<number, string>} messageNumberMap - 消息编号映射表（编号→消息ID）
 * @returns {Promise<Object>} { content: 历史聊天记录内容, nextNumber: 下一个可用编号 }
 *
 * @description
 * 包含最新recentCount之前的historyCount条消息（不包括excluded的）
 * 每条消息加临时编号 [#N]，保存到映射表
 */
export async function buildHistoryChatInfo(contactId, contact, messageNumberMap) {
  // 动态导入工具函数
  const { formatTimeForAI } = await import('../utils/time-helper.js');
  const { getUserDisplayName } = await import('../utils/contact-display-helper.js');
  const { findEmojiById } = await import('../emojis/emoji-manager-data.js');
  const { getChatSendSettings } = await import('../messages/message-chat-data.js');

  const userName = getUserDisplayName();
  const sendSettings = getChatSendSettings(contactId);

  // 加载历史记录
  const allHistory = await loadChatHistory(contactId);

  // 过滤出非排除的消息
  const validHistory = allHistory.filter(msg => !msg.excluded);

  // 计算历史消息范围
  const totalValid = validHistory.length;
  const historyStart = Math.max(0, totalValid - sendSettings.recentCount - sendSettings.historyCount);
  const historyEnd = Math.max(0, totalValid - sendSettings.recentCount);
  const historyMessages = validHistory.slice(historyStart, historyEnd);

  if (historyMessages.length === 0) {
    return { content: '', nextNumber: 1 };  // 没有历史消息
  }

  let content = '';
  let currentNumber = 1;

  // 遍历历史消息
  historyMessages.forEach((msg, index) => {
    const senderName = msg.sender === 'user' ? userName : contact.name;
    const prevTime = index > 0 ? historyMessages[index - 1].time : null;
    const isFirst = index === 0;

    // 智能时间显示
    const timeStr = formatTimeForAI(msg.time, prevTime, isFirst);

    // 根据消息类型添加前缀
    let messageContent = msg.content;
    if (msg.type === 'poke') {
      // 戳一戳消息
      messageContent = '[戳一戳]';
    } else if (msg.type === 'emoji') {
      const emoji = findEmojiById(msg.content);
      if (emoji) {
        messageContent = `[表情]${emoji.name}`;
      } else {
        messageContent = msg.emojiName ? `[表情]${msg.emojiName}` : `[表情包已删除]`;
      }
    } else if (msg.type === 'image-real') {
      // ✅ 真实图片（新类型）：只显示描述（图片已在历史中识别）
      messageContent = msg.description || '';
    } else if (msg.type === 'image-fake') {
      // ✅ 假装图片（新类型）：显示 [图片]描述
      messageContent = `[图片]${msg.description || '无描述'}`;
    } else if (msg.type === 'image') {
      // ✅ 旧数据兼容：根据 imageUrl 判断类型
      if (msg.imageUrl) {
        // 真实图片：只显示描述
        messageContent = msg.description || '';
      } else {
        // 假装图片：显示 [图片]描述
        messageContent = `[图片]${msg.description || '无描述'}`;
      }
    } else if (msg.type === 'quote') {
      // 引用消息：格式化为 [引用]原内容[回复]回复内容
      const quotedText = formatQuotedMessageForAI(msg.quotedMessage);
      messageContent = `[引用]${quotedText}[回复]${msg.replyContent}`;
    } else if (msg.type === 'forwarded') {
      // 转发消息：格式化内层消息，添加时间戳
      messageContent = formatForwardedMessageForAI(msg, userName, formatTimeForAI);
    }

    // ✅ 添加临时编号 + 保存映射
    if (msg.id) {
      messageNumberMap.set(currentNumber, msg.id);
      content += `[#${currentNumber}] ${timeStr}${senderName}: ${messageContent}\n`;
      currentNumber++;
    } else {
      // 旧数据兼容：没有ID的消息不加编号
      content += `${timeStr}${senderName}: ${messageContent}\n`;
    }
  });

  logger.debug('phone','[ContextBuilder] 历史聊天记录构建完成，共', historyMessages.length, '条');

  return {
    content,
    nextNumber: currentNumber
  };
}

/**
 * 获取预设数据（从extension_settings读取）
 *
 * @private
 * @returns {Object} 预设数据
 *
 * @description
 * ✅ 重构：统一使用 preset-settings-ui.js 的默认预设定义
 * 删除了本地的默认预设和迁移逻辑，实现单一数据源
 * ✅ 每次调用都读取最新数据，确保UI重置后立即生效
 */
function getPresetData() {
  if (!extension_settings.acsusStandalonePhone) {
    extension_settings.acsusStandalonePhone = {};
  }
  if (!extension_settings.acsusStandalonePhone.phone) {
    extension_settings.acsusStandalonePhone.phone = {};
  }

  // ✅ 如果不存在promptPreset，使用统一的默认预设
  if (!extension_settings.acsusStandalonePhone.phone.promptPreset) {
    logger.warn('phone','[ContextBuilder] 预设数据不存在，使用默认预设（来自preset-settings-ui）');
    extension_settings.acsusStandalonePhone.phone.promptPreset = getDefaultPresets();
    saveSettingsDebounced();
  }

  // ✅ 始终返回 extension_settings 中的最新数据（而非缓存）
  return extension_settings.acsusStandalonePhone.phone.promptPreset;
}

/**
 * 构建表情包库内容
 *
 * @async
 * @private
 * @param {string} userPrompt - 用户自定义的提示词（在[/表情包库]后面）
 * @returns {Promise<string>} 完整的表情包库内容
 *
 * @description
 * 动态生成表情包库标签 + 表情包列表 + 用户提示词
 */
async function buildEmojiLibrary(userPrompt) {
  logger.debug('phone','[ContextBuilder.buildEmojiLibrary] 开始构建表情包库');

  // 动态导入表情包数据
  const { getEmojiNames } = await import('../emojis/emoji-manager-data.js');
  const emojiNames = getEmojiNames();

  if (emojiNames.length === 0) {
    logger.debug('phone','[ContextBuilder.buildEmojiLibrary] 没有表情包，跳过');
    return '';  // 没有表情包时返回空字符串（会被过滤掉）
  }

  // 构建完整内容
  let content = '[表情包库]\n';
  content += emojiNames.join('\n');  // 每行一个表情包名称
  content += '\n[/表情包库]\n';

  // 追加用户的提示词
  if (userPrompt && userPrompt.trim()) {
    content += userPrompt.trim();
  }

  logger.debug('phone','[ContextBuilder.buildEmojiLibrary] 构建完成，表情包数量:', emojiNames.length);
  return content;
}

/**
 * 检查并触发AI感知删除的好友申请（概率触发机制）
 *
 * @async
 * @private
 * @returns {Promise<Array>} 触发的好友申请列表（为空数组表示未触发）
 *
 * @description
 * 当用户发送消息时，检查所有AI感知删除的角色：
 * 1. 获取所有AI感知删除的申请列表
 * 2. 过滤出允许继续申请（allowReapply=true）且概率>0的角色
 * 3. 对每个角色独立进行概率判断（roll点）
 * 4. 返回触发的角色列表（包含contactId、contactName、deleteTime等信息）
 */
async function checkAndTriggerAIAwareReapply() {
  logger.debug('phone','[ContextBuilder.checkAIAwareReapply] 开始检查AI感知删除触发');

  try {
    // 动态导入数据层函数
    const { getAIAwareDeletedRequests } = await import('../contacts/contact-list-data.js');

    // 获取所有AI感知删除的申请
    const requests = await getAIAwareDeletedRequests();

    if (!requests || requests.length === 0) {
      logger.debug('phone','[ContextBuilder.checkAIAwareReapply] 没有AI感知删除的申请');
      return [];
    }

    // 过滤出允许继续申请且概率>0的角色
    const activeRequests = requests.filter(r => {
      const config = r.reapplyConfig || {};
      return config.allowReapply === true && (config.probability || 0) > 0;
    });

    if (activeRequests.length === 0) {
      logger.debug('phone','[ContextBuilder.checkAIAwareReapply] 没有允许继续申请的角色');
      return [];
    }

    logger.info('phone','[ContextBuilder.checkAIAwareReapply] 检测到', activeRequests.length, '个可触发角色');

    // 对每个角色独立进行概率判断
    const triggeredRequests = [];
    for (const request of activeRequests) {
      const probability = request.reapplyConfig.probability || 0;
      const roll = Math.random() * 100;  // 0-100的随机数

      logger.debug('phone','[ContextBuilder.checkAIAwareReapply] 角色:', request.contactName, '概率:', probability, 'roll:', roll.toFixed(2));

      if (roll <= probability) {
        triggeredRequests.push(request);
        logger.info('phone','[ContextBuilder.checkAIAwareReapply] 触发!', request.contactName, `(${roll.toFixed(2)} <= ${probability})`);
      }
    }

    if (triggeredRequests.length === 0) {
      logger.debug('phone','[ContextBuilder.checkAIAwareReapply] 本轮没有角色触发');
      return [];
    }

    logger.info('phone','[ContextBuilder.checkAIAwareReapply] 已触发', triggeredRequests.length, '个角色的好友申请');
    return triggeredRequests;

  } catch (error) {
    logger.error('phone','[ContextBuilder.checkAIAwareReapply] 检查失败:', error);
    return [];
  }
}

