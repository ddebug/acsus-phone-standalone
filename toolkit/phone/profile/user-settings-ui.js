import { extension_settings } from '../../../standalone/phone-settings.js';
/**
 * 用户设置页面 UI 渲染
 * 
 * 职责：
 * - 渲染设置页面（顶部栏、可用设置项）
 * - 处理返回逻辑（使用 page-stack-helper）
 *
 * 设计特点：
 * - 独立页面，全屏显示
 * - CSS 类名前缀：settings-*
 * - 头像从顶部栏用户头像获取
 */

import logger from '../../../logger.js';
import { hidePage } from '../phone-main-ui.js';


/**
 * 渲染用户设置页面
 * 
 * @async
 * @returns {Promise<DocumentFragment>} 设置页面内容片段
 */
export async function renderUserSettings() {
  logger.info('phone','[UserSettings] 开始渲染用户设置页');

  // 创建文档片段
  const fragment = document.createDocumentFragment();

  // 创建内容容器
  const container = document.createElement('div');
  container.className = 'user-settings-page';

  // 页面内容
  container.innerHTML = `
        <!-- 顶部栏 -->
        <div class="user-settings-topbar">
            <button class="user-settings-back-btn">
                <i class="fa-solid fa-chevron-left"></i>
            </button>
            <div class="user-settings-title">设置</div>
        </div>

        <!-- 内容区 -->
        <div class="phone-settings-content">
            <!-- 功能分组：只保留真的能打开的设置 -->
            <div class="phone-settings-section">
                <div class="phone-settings-section-title">功能</div>
                <div class="phone-settings-section-content">
                    <div class="phone-settings-item" id="phone-image-mode-setting-link">
                        <i class="fa-solid fa-image"></i>
                        <div class="phone-settings-item-content">
                            <span class="phone-settings-item-text">图片识别模式</span>
                            <span class="phone-settings-item-extra" id="phone-image-mode-display">仅本轮</span>
                        </div>
                        <i class="fa-solid fa-chevron-right phone-settings-item-arrow"></i>
                    </div>
                    <button type="button" class="phone-settings-item" id="standalone-phone-proactive-link" style="width:100%;background:transparent;border:0;text-align:left;font:inherit;color:var(--phone-text-primary);">
                        <i class="fa-solid fa-comment-dots"></i>
                        <div class="phone-settings-item-content">
                            <span class="phone-settings-item-text">角色主动消息</span>
                            <span class="phone-settings-item-extra">沉默 / 定时</span>
                        </div>
                        <i class="fa-solid fa-chevron-right phone-settings-item-arrow"></i>
                    </button>
                    <div class="phone-settings-item" id="phone-storage-space-link">
                        <i class="fa-solid fa-database"></i>
                        <span class="phone-settings-item-text">存储空间</span>
                        <i class="fa-solid fa-chevron-right phone-settings-item-arrow"></i>
                    </div>
                </div>
            </div>
        </div>
    `;

  // 绑定返回按钮事件
  bindBackButton(container);

  // 绑定设置项点击事件
  bindSettingItems(container);

  fragment.appendChild(container);

  logger.info('phone','[UserSettings] 设置页渲染完成');
  return fragment;
}

/**
 * 绑定返回按钮事件
 * 
 * @param {HTMLElement} pageElement - 页面元素
 */
function bindBackButton(pageElement) {
  const backBtn = pageElement.querySelector('.user-settings-back-btn');
  if (!backBtn) {
    logger.warn('phone','[UserSettings] 找不到返回按钮');
    return;
  }

  backBtn.addEventListener('click', () => {
    logger.debug('phone','[UserSettings] 点击返回按钮');
    const overlayElement = /** @type {HTMLElement} */ (document.querySelector('.phone-overlay'));
    if (overlayElement) {
      hidePage(overlayElement, 'user-settings');
    }
  });
}

/**
 * 绑定设置项点击事件
 * 
 * @param {HTMLElement} pageElement - 页面元素
 */
function bindSettingItems(pageElement) {
  pageElement.querySelector('#standalone-phone-proactive-link')?.addEventListener('click', () => {
    void (async () => {
      const overlay = document.querySelector('.phone-overlay');
      if (!overlay) return;
      const { showPage } = await import('../phone-main-ui.js');
      await showPage(overlay, 'proactive-settings');
    })().catch(() => logger.warn('phone', '[UserSettings] 主动消息设置打开失败，请重新打开手机'));
  });
  // 图片识别模式
  const imageModeLink = pageElement.querySelector('#phone-image-mode-setting-link');
  if (imageModeLink) {
    imageModeLink.addEventListener('click', async () => {
      logger.info('phone','[UserSettings] 打开图片识别模式设置');
      const overlayElement = /** @type {HTMLElement} */ (document.querySelector('.phone-overlay'));
      if (overlayElement) {
        const { showPage } = await import('../phone-main-ui.js');
        showPage(overlayElement, 'image-mode-settings', {});
      }
    });
  }

  // 存储空间
  const storageSpaceLink = pageElement.querySelector('#phone-storage-space-link');
  if (storageSpaceLink) {
    storageSpaceLink.addEventListener('click', async () => {
      logger.info('phone','[UserSettings] 打开存储空间');
      const overlayElement = /** @type {HTMLElement} */ (document.querySelector('.phone-overlay'));
      if (overlayElement) {
        const { showPage } = await import('../phone-main-ui.js');
        showPage(overlayElement, 'storage-space', {});
      }
    });
  }

  // 更新图片模式显示文本
  updateImageModeDisplay(pageElement);

  // 监听图片模式变化
  document.addEventListener('phone-image-mode-changed', () => {
    updateImageModeDisplay(pageElement);
  });
}

/**
 * 更新图片模式显示文本
 * @private
 */
function updateImageModeDisplay(pageElement) {
  const mode = extension_settings.acsusStandalonePhone?.phone?.imageMode || 'once';
  
  const modeText = {
    once: '仅本轮',
    always: '每轮都识别',
    never: '永不识别'
  };

  const displayEl = pageElement.querySelector('#phone-image-mode-display');
  if (displayEl) {
    displayEl.textContent = modeText[mode] || '仅本轮';
  }
}

