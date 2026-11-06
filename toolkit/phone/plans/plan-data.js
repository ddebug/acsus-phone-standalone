import { extension_settings, saveSettingsDebounced } from '../../../standalone/phone-settings.js';
/**
 * 约定计划数据管理
 * @module phone/plans/plan-data
 *
 * @description
 * 管理约定计划的数据存储和状态
 * 职责：
 * - 计划的增删改查
 * - 状态管理（待响应、已接受、已拒绝、已完成）
 * - 数据持久化到 extension_settings
 */

import logger from '../../../logger.js';


import { stateManager } from '../utils/state-manager.js';

/**
 * 确保计划相关数据结构存在
 * @description 初始化 plans（计划列表）和 planHistory（计划历史记录）
 * @private
 */
function ensurePlansData() {
  if (!extension_settings.acsusStandalonePhone) {
    extension_settings.acsusStandalonePhone = {};
  }
  if (!extension_settings.acsusStandalonePhone.phone) {
    extension_settings.acsusStandalonePhone.phone = {};
  }
  if (!extension_settings.acsusStandalonePhone.phone.plans) {
    extension_settings.acsusStandalonePhone.phone.plans = {};
  }
  if (!extension_settings.acsusStandalonePhone.phone.planHistory) {
    extension_settings.acsusStandalonePhone.phone.planHistory = {};
  }
}

/**
 * 获取联系人的所有计划
 * @param {string} contactId - 联系人ID
 * @returns {Array<Object>} 计划列表
 */
export function getPlans(contactId) {
  ensurePlansData();

  if (!extension_settings.acsusStandalonePhone.phone.plans[contactId]) {
    extension_settings.acsusStandalonePhone.phone.plans[contactId] = [];
  }

  const plans = extension_settings.acsusStandalonePhone.phone.plans[contactId];
  logger.debug('phone','[PlanData.getPlans] 获取计划列表:', contactId, '计划数:', plans.length, '数据:', plans);
  return plans;
}

/**
 * 根据消息ID查找计划
 * @param {string} contactId - 联系人ID
 * @param {string} messageId - 消息ID
 * @returns {Object|null} 计划对象或null
 */
export function getPlanByMessageId(contactId, messageId) {
  const plans = getPlans(contactId);
  return plans.find(p => p.messageId === messageId) || null;
}

/**
 * 创建新计划
 *
 * @async
 * @param {string} contactId - 联系人ID
 * @param {Object} planData - 计划数据
 * @param {string} planData.messageId - 关联的消息ID
 * @param {string} planData.title - 计划标题
 * @param {string} planData.content - 计划内容
 * @param {string} planData.initiator - 发起者（'user' | 'char'）
 * @param {number} planData.timestamp - 创建时间戳
 * @returns {Promise<Object>} 创建的计划对象
 */
export async function createPlan(contactId, planData) {
  ensurePlansData();

  // 🔥 持久化去重：检查是否已处理过该消息（支持重新应用）
  if (planData.messageId) {
    const history = extension_settings.acsusStandalonePhone.phone.planHistory[contactId] || [];
    const existingRecord = history.find(h => h.msgId === planData.messageId);

    if (existingRecord) {
      logger.warn('phone','[PlanData] 该消息已处理过，跳过重复创建 msgId:', planData.messageId);

      // 返回已存在的计划
      const existingPlan = getPlanByMessageId(contactId, planData.messageId);
      if (existingPlan) {
        return existingPlan;
      }

      // 如果历史记录存在但计划不存在（数据不一致），清理历史记录并继续创建
      logger.warn('phone','[PlanData] 历史记录存在但计划不存在，清理历史记录');
      const historyIndex = history.findIndex(h => h.msgId === planData.messageId);
      if (historyIndex !== -1) {
        history.splice(historyIndex, 1);
      }
    }
  }

  const plans = getPlans(contactId);

  // 创建计划对象
  const plan = {
    id: `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    messageId: planData.messageId,
    title: planData.title,
    content: planData.content,
    initiator: planData.initiator,
    status: 'pending', // pending待响应 / accepted已接受 / rejected已拒绝 / completed已完成
    timestamp: planData.timestamp,
    diceResult: null,
    outcome: null, // '顺利' | '麻烦' | '好事'
    story: null,
    storyGenerated: false, // 是否已生成剧情（避免重复提示）
    notes: {
      notedProcess: null,       // 记录的计划过程要点
      notedInnerThought: null,  // 记录的内心印象要点
      notedRecord: null         // 记录的过程记录要点
    },
    options: {
      includeInnerThought: false,
      includeRecord: false
    }
  };

  plans.push(plan);
  extension_settings.acsusStandalonePhone.phone.plans[contactId] = plans;

  // 🔥 记录到历史（防止重新应用时重复创建）
  if (planData.messageId) {
    if (!extension_settings.acsusStandalonePhone.phone.planHistory[contactId]) {
      extension_settings.acsusStandalonePhone.phone.planHistory[contactId] = [];
    }
    extension_settings.acsusStandalonePhone.phone.planHistory[contactId].push({
      planId: plan.id,
      msgId: planData.messageId,
      timestamp: Date.now()
    });
    logger.debug('phone','[PlanData] 已记录到历史:', planData.messageId);
  }

  saveSettingsDebounced();

  logger.info('phone','[PlanData] 创建计划:', plan.title, 'ID:', plan.id);

  // 🔥 通过状态管理器通知订阅者
  await stateManager.set('plans', extension_settings.acsusStandalonePhone.phone.plans, {
    contactId,
    planId: plan.id,
    action: 'create'
  });

  return plan;
}

/**
 * 更新计划状态
 *
 * @param {string} contactId - 联系人ID
 * @param {string} planId - 计划ID
 * @param {string} status - 新状态（'pending' | 'accepted' | 'rejected' | 'completed'）
 * @returns {Promise<boolean>} 是否成功
 */
export async function updatePlanStatus(contactId, planId, status) {
  const plans = getPlans(contactId);
  const plan = plans.find(p => p.id === planId);

  if (!plan) {
    logger.warn('phone','[PlanData] 未找到计划:', planId);
    return false;
  }

  plan.status = status;
  saveSettingsDebounced();

  logger.info('phone','[PlanData] 更新计划状态:', plan.title, '→', status);

  // 🔥 通过状态管理器通知订阅者
  await stateManager.set('plans', extension_settings.acsusStandalonePhone.phone.plans, {
    contactId,
    planId,
    action: 'update'
  });

  return true;
}

/**
 * 更新计划执行结果
 *
 * @param {string} contactId - 联系人ID
 * @param {string} planId - 计划ID
 * @param {Object} result - 执行结果
 * @param {number} result.diceResult - 骰子结果（1-100）
 * @param {string} result.outcome - 结果类型（'顺利' | '麻烦' | '好事'）
 * @param {string} result.story - 剧情梗概
 * @param {Object} [result.options] - 可选配置
 * @returns {Promise<boolean>} 是否成功
 */
export async function updatePlanResult(contactId, planId, result) {
  const plans = getPlans(contactId);
  const plan = plans.find(p => p.id === planId);

  if (!plan) {
    logger.warn('phone','[PlanData] 未找到计划:', planId);
    return false;
  }

  plan.diceResult = result.diceResult;
  plan.outcome = result.outcome;
  plan.story = result.story;

  if (result.options) {
    plan.options = { ...plan.options, ...result.options };
  }

  plan.status = 'completed';
  saveSettingsDebounced();

  logger.info('phone','[PlanData] 更新计划结果:', plan.title, '骰子:', plan.diceResult, '结果:', plan.outcome);

  // 🔥 通过状态管理器通知订阅者
  await stateManager.set('plans', extension_settings.acsusStandalonePhone.phone.plans, {
    contactId,
    planId,
    action: 'update'
  });

  return true;
}

/**
 * 删除计划
 * @param {string} contactId - 联系人ID
 * @param {string} planId - 计划ID
 * @returns {Promise<boolean>} 是否成功
 */
export async function deletePlan(contactId, planId) {
  ensurePlansData();

  const plans = getPlans(contactId);
  const index = plans.findIndex(p => p.id === planId);

  if (index === -1) {
    logger.warn('phone','[PlanData] 未找到计划:', planId);
    return false;
  }

  const plan = plans[index];
  plans.splice(index, 1);
  extension_settings.acsusStandalonePhone.phone.plans[contactId] = plans;

  // 🔥 删除历史记录（重要：支持重新应用）
  if (plan.messageId) {
    const history = extension_settings.acsusStandalonePhone.phone.planHistory[contactId] || [];
    const historyIndex = history.findIndex(h => h.msgId === plan.messageId);

    if (historyIndex !== -1) {
      history.splice(historyIndex, 1);
      logger.debug('phone','[PlanData] 已删除历史记录:', plan.messageId);
    }
  }

  saveSettingsDebounced();

  logger.info('phone','[PlanData] 删除计划:', plan.title);

  // 🔥 通过状态管理器通知订阅者
  await stateManager.set('plans', extension_settings.acsusStandalonePhone.phone.plans, {
    contactId,
    planId,
    action: 'delete'
  });

  return true;
}

/**
 * 获取待响应的计划
 * @param {string} contactId - 联系人ID
 * @returns {Array<Object>} 待响应计划列表
 */
export function getPendingPlans(contactId) {
  const plans = getPlans(contactId);
  const pendingPlans = plans.filter(p => p.status === 'pending' || p.status === 'accepted');
  logger.debug('phone','[PlanData.getPendingPlans] 进行中计划:', contactId, '数量:', pendingPlans.length, '数据:', pendingPlans);
  return pendingPlans;
}

/**
 * 获取已完成的计划
 * @param {string} contactId - 联系人ID
 * @returns {Array<Object>} 已完成计划列表
 */
export function getCompletedPlans(contactId) {
  const plans = getPlans(contactId);
  const completedPlans = plans.filter(p => p.status === 'completed');
  logger.debug('phone','[PlanData.getCompletedPlans] 已完成计划:', contactId, '数量:', completedPlans.length, '数据:', completedPlans);
  return completedPlans;
}

/**
 * 标记计划的剧情已生成
 * @param {string} contactId - 联系人ID
 * @param {string} planId - 计划ID
 * @param {boolean} generated - 是否已生成
 * @returns {boolean} 是否成功
 */
export function updatePlanStoryGenerated(contactId, planId, generated) {
  const plans = getPlans(contactId);
  const plan = plans.find(p => p.id === planId);

  if (!plan) {
    logger.warn('phone','[PlanData] 未找到计划:', planId);
    return false;
  }

  plan.storyGenerated = generated;
  saveSettingsDebounced();

  logger.info('phone','[PlanData] 更新剧情生成状态:', plan.title, '→', generated);
  return true;
}

/**
 * 保存计划要点
 *
 * @param {string} contactId - 联系人ID
 * @param {string} planId - 计划ID
 * @param {string} noteType - 要点类型（'process' | 'innerThought' | 'record'）
 * @param {string} content - 要点内容
 * @returns {boolean} 是否成功
 */
export function savePlanNote(contactId, planId, noteType, content) {
  const plans = getPlans(contactId);
  const plan = plans.find(p => p.id === planId);

  if (!plan) {
    logger.warn('phone','[PlanData] 未找到计划:', planId);
    return false;
  }

  // 确保notes对象存在
  if (!plan.notes) {
    plan.notes = {
      notedProcess: null,
      notedInnerThought: null,
      notedRecord: null
    };
  }

  // 保存要点
  const noteFieldMap = {
    'process': 'notedProcess',
    'innerThought': 'notedInnerThought',
    'record': 'notedRecord'
  };

  const fieldName = noteFieldMap[noteType];
  if (!fieldName) {
    logger.error('phone','[PlanData] 无效的要点类型:', noteType);
    return false;
  }

  plan.notes[fieldName] = content;
  saveSettingsDebounced();

  logger.info('phone','[PlanData] 保存计划要点:', plan.title, '类型:', noteType);
  return true;
}

/**
 * 删除计划要点
 *
 * @param {string} contactId - 联系人ID
 * @param {string} planId - 计划ID
 * @param {string} noteType - 要点类型（'process' | 'innerThought' | 'record'）
 * @returns {boolean} 是否成功
 */
export function deletePlanNote(contactId, planId, noteType) {
  const plans = getPlans(contactId);
  const plan = plans.find(p => p.id === planId);

  if (!plan) {
    logger.warn('phone','[PlanData] 未找到计划:', planId);
    return false;
  }

  if (!plan.notes) {
    return true; // 本来就没有notes
  }

  // 删除要点
  const noteFieldMap = {
    'process': 'notedProcess',
    'innerThought': 'notedInnerThought',
    'record': 'notedRecord'
  };

  const fieldName = noteFieldMap[noteType];
  if (!fieldName) {
    logger.error('phone','[PlanData] 无效的要点类型:', noteType);
    return false;
  }

  plan.notes[fieldName] = null;
  saveSettingsDebounced();

  logger.info('phone','[PlanData] 删除计划要点:', plan.title, '类型:', noteType);
  return true;
}

/**
 * 检查计划是否有任意记录的要点
 *
 * @param {Object} plan - 计划对象
 * @returns {boolean} 是否有记录的要点
 */
export function hasAnyNotes(plan) {
  if (!plan || !plan.notes) {
    return false;
  }

  return !!(plan.notes.notedProcess || plan.notes.notedInnerThought || plan.notes.notedRecord);
}

