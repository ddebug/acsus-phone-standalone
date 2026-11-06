import { extension_settings, saveSettingsDebounced } from '../../../standalone/phone-settings.js';
/**
 * 数据存储接口
 * @module phone/data-storage/storage-api
 */

import logger from '../../../logger.js';



const STORAGE_KEY = 'acsusStandalonePhone';

/**
 * 保存数据到 extension_settings
 * 
 * @description
 * 使用独立手机的内存 facade，不读写酒馆 extension_settings。
 * 保存通过独立用户文件适配器完成。
 * 
 * @async
 * @param {string} key - 数据键（如 'contacts', 'messages'）
 * @param {Object} data - 数据对象
 */
async function saveData(key, data) {
  logger.debug('phone','[Storage] 保存数据:', key);

  try {
    // 确保扩展设置对象存在
    if (!extension_settings[STORAGE_KEY]) {
      extension_settings[STORAGE_KEY] = {};
    }

    if (!extension_settings[STORAGE_KEY].phone) {
      extension_settings[STORAGE_KEY].phone = {};
    }

    // 保存数据
    extension_settings[STORAGE_KEY].phone[key] = data;

    // 等待独立用户文件写入确认；不调用酒馆总设置保存函数。
    await saveSettingsDebounced();

    logger.debug('phone','[Storage] 数据已保存并同步:', key);
  } catch (error) {
    logger.error('phone','[Storage] 保存数据失败:', error);
    throw error;
  }
}

/**
 * 从 extension_settings 读取数据
 * 
 * @description
 * 从 SillyTavern 的 extension_settings 读取数据
 * 
 * @async
 * @param {string} key - 数据键（如 'contacts', 'messages'）
 * @returns {Promise<Object|null>} 数据对象，不存在则返回 null
 */
async function loadData(key) {
  logger.debug('phone','[Storage] 读取数据:', key);

  try {
    // 检查路径是否存在
    if (!extension_settings[STORAGE_KEY]) {
      logger.debug('phone','[Storage] 扩展设置不存在，返回 null');
      return null;
    }

    if (!extension_settings[STORAGE_KEY].phone) {
      logger.debug('phone','[Storage] phone 数据不存在，返回 null');
      return null;
    }

    const data = extension_settings[STORAGE_KEY].phone[key];

    if (data === undefined || data === null) {
      logger.debug('phone','[Storage] 数据不存在:', key);
      return null;
    }

    logger.debug('phone','[Storage] 数据已读取:', key);
    return data;
  } catch (error) {
    logger.error('phone','[Storage] 读取数据失败:', error);
    return null;
  }
}

export {
  saveData,
  loadData
};

