import { extension_settings, saveSettingsDebounced as saveSetting } from '../../../standalone/phone-settings.js';
/**
 * 图片数据管理模块（学习表情包管理器模式）
 * @module phone/storage/image-data
 */


import logger from '../../../logger.js';
import { stateManager } from '../utils/state-manager.js';

/**
 * 获取上传图片列表
 *
 * @returns {Array<Object>} 图片数组
 *
 * @description
 * 返回格式：
 * [
 *   {
 *     id: '1763883714461',          // 图片ID（时间戳）
 *     filename: 'phone_xxx.jpg',    // 文件名
 *     imagePath: '/user/files/...',  // 图片路径
 *     size: 256000,                  // 文件大小（字节）
 *     addedTime: 1763883714461      // 添加时间（毫秒）
 *   }
 * ]
 */
export function getUploadedImages() {
    if (!extension_settings.acsusStandalonePhone) {
        extension_settings.acsusStandalonePhone = {};
    }
    if (!extension_settings.acsusStandalonePhone.phone) {
        extension_settings.acsusStandalonePhone.phone = {};
    }

    // 数据迁移：兼容旧版本数组格式
    if (!extension_settings.acsusStandalonePhone.phone.uploadedImages) {
        extension_settings.acsusStandalonePhone.phone.uploadedImages = { items: [] };
    } else if (Array.isArray(extension_settings.acsusStandalonePhone.phone.uploadedImages)) {
        // 旧数据是数组格式，迁移到新格式
        logger.warn('phone','[ImageData] 检测到旧数据格式，正在迁移...');
        const oldData = extension_settings.acsusStandalonePhone.phone.uploadedImages;
        extension_settings.acsusStandalonePhone.phone.uploadedImages = { items: oldData };
        logger.info('phone','[ImageData] 数据迁移完成，共', oldData.length, '条记录');

        // 同步 getter 只修正内存形状；异步持久化成功后才记录成功信息。
        Promise.resolve(saveSetting()).then(() => {
            logger.info('phone','[ImageData] 已保存迁移后的数据到独立存储');
        }).catch(error => {
            logger.error('phone','[ImageData] 保存图片结构迁移失败:', error);
        });
    }

    return extension_settings.acsusStandalonePhone.phone.uploadedImages.items;
}

/**
 * 保存图片记录
 *
 * @async
 * @param {Object} image - 图片对象
 * @param {string} image.id - 图片ID
 * @param {string} image.filename - 文件名
 * @param {string} image.imagePath - 图片路径
 * @param {number} image.size - 文件大小（字节）
 * @param {number} image.addedTime - 添加时间（毫秒）
 * @returns {Promise<boolean>} 是否成功
 */
export async function saveImage(image) {
    const images = getUploadedImages();

    // 检查是否已存在（按文件名）
    const index = images.findIndex(img => img.filename === image.filename);
    if (index !== -1) {
        // 更新已有记录
        images[index] = image;
        logger.info('phone','[ImageData] 已更新图片记录:', image.filename);
    } else {
        // 添加新记录
        images.push(image);
        logger.info('phone','[ImageData] 已添加图片记录:', image.filename);
    }

    await saveSetting();

    // 通知订阅者数据已变化
    await stateManager.set('images', getUploadedImages(), {
        action: index !== -1 ? 'update' : 'add',
        image: image
    });

    return true;
}

/**
 * 删除图片（批量）
 *
 * @async
 * @param {Array<string>} filenames - 要删除的文件名列表
 * @returns {Promise<{deletedCount: number, successCount: number, failCount: number, physicalFilesRetained: boolean}>} 记录移除结果
 *
 * @description
 * 只移除独立版图片记录，绝不删除服务器物理文件（可能与原版/聊天共用）。
 * successCount/failCount 为兼容现有 UI 保留，表示记录移除，不是物理文件操作。
 */
export async function deleteImages(filenames) {
    const images = getUploadedImages();
    const beforeCount = images.length;

    // Record-only removal. The independent store does not own shared host files.
    // 过滤掉要删除的图片（从数据中移除）
    extension_settings.acsusStandalonePhone.phone.uploadedImages.items =
        images.filter(img => !filenames.includes(img.filename));

    const deletedCount = beforeCount - extension_settings.acsusStandalonePhone.phone.uploadedImages.items.length;
    const successCount = deletedCount;
    const failCount = 0;
    logger.info('phone',`[ImageData] 已移除 ${deletedCount} 条图片记录；物理文件保留`);

    await saveSetting();

    // 通知订阅者数据已变化
    if (deletedCount > 0) {
        await stateManager.set('images', getUploadedImages(), {
            action: 'delete',
            count: deletedCount,
            successCount,
            failCount,
            physicalFilesRetained: true
        });
    }

    return { deletedCount, successCount, failCount, physicalFilesRetained: true };
}

/**
 * 根据文件名查找图片
 *
 * @param {string} filename - 文件名
 * @returns {Object|null} 图片对象
 */
export function findImageByFilename(filename) {
    const images = getUploadedImages();
    return images.find(img => img.filename === filename) || null;
}

/**
 * 根据ID查找图片
 *
 * @param {string} id - 图片ID
 * @returns {Object|null} 图片对象
 */
export function findImageById(id) {
    const images = getUploadedImages();
    return images.find(img => img.id === id) || null;
}

/**
 * 清空所有图片记录（不删除文件）
 *
 * @async
 * @description
 * 用于数据重置或迁移，只清空记录，不删除实际文件
 */
export async function clearAllImages() {
    const count = getUploadedImages().length;
    extension_settings.acsusStandalonePhone.phone.uploadedImages.items = [];
    await saveSetting();

    logger.info('phone','[ImageData] 已清空所有图片记录，数量:', count);

    // 通知订阅者数据已变化
    await stateManager.set('images', [], {
        action: 'clear',
        count
    });
}
