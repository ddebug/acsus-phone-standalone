/**
 * 主题管理器（Theme Manager）
 *
 * @description
 * 管理手机界面的日间、经典夜间和深夜毛玻璃主题
 *
 * 核心功能：
 * 1. 切换主题（toggle）
 * 2. 设置主题（set）
 * 3. 获取当前主题（get）
 * 4. 持久化保存（独立的 settings.theme 设置）
 * 5. 初始化加载（init）
 *
 * 性能优化：
 * - 只修改一个 data-theme 属性，浏览器自动重新计算CSS变量
 * - 不遍历元素修改样式，性能极佳，不会卡顿
 */

import logger from '../../../logger.js';
import { saveData, loadData } from '../data-storage/storage-api.js';
import { extension_settings } from '../../../standalone/phone-settings.js';

// 主题常量
const THEME = {
  LIGHT: 'light',
  DARK: 'dark',
  GLASS_DARK: 'glass-dark'
};

// 手机界面主题独立于装扮商店主题；新增主题仅在用户明确选择后启用。
export const PHONE_THEMES = Object.freeze([
  Object.freeze({ id: THEME.LIGHT, label: '日间', icon: 'fa-sun' }),
  Object.freeze({ id: THEME.DARK, label: '经典夜间', icon: 'fa-moon' }),
  Object.freeze({ id: THEME.GLASS_DARK, label: '深夜毛玻璃', icon: 'fa-star' })
]);

function normalizeTheme(theme) {
  return PHONE_THEMES.some(option => option.id === theme) ? theme : THEME.LIGHT;
}

// 存储键名
const STORAGE_KEY = 'settings';

/**
 * 初始化主题管理器
 *
 * @description
 * 从存储加载主题设置，应用到界面
 * 在手机界面创建时调用一次
 *
 * @async
 * @param {HTMLElement} [container] - 可选，手机容器元素（.phone-container）
 *                                    如果传入则直接应用，不传则从 document 查找
 */
export async function initTheme(container) {
  logger.debug('phone','[ThemeManager] 初始化主题');

  // 从存储加载主题
  const savedTheme = await getTheme();

  // 应用主题（支持传入容器元素）
  applyTheme(savedTheme, container);

  logger.info('phone',`[ThemeManager] 主题已初始化: ${savedTheme}`);
}

/**
 * 切换主题（Toggle）
 *
 * @description
 * 保留旧的日间 <-> 经典夜间切换；任一夜间主题切回日间。
 *
 * @async
 * @returns {Promise<string>} 切换后的主题 ('light' | 'dark')
 */
export async function toggleTheme() {
  const currentTheme = await getTheme();
  const newTheme = currentTheme === THEME.LIGHT ? THEME.DARK : THEME.LIGHT;

  await setTheme(newTheme);

  logger.info('phone',`[ThemeManager] 主题已切换: ${currentTheme} -> ${newTheme}`);

  return newTheme;
}

/**
 * 设置主题
 *
 * @async
 * @param {string} theme - 主题名称 ('light' | 'dark' | 'glass-dark')
 */
export async function setTheme(theme) {
  const normalizedTheme = normalizeTheme(theme);
  if (normalizedTheme !== theme) {
    logger.warn('phone',`[ThemeManager] 无效的主题: ${theme}，使用默认主题 'light'`);
  }
  theme = normalizedTheme;

  // 保存成功后再应用，避免保存失败时界面与持久化主题不一致。
  await saveTheme(theme);
  applyTheme(theme);

  logger.debug('phone',`[ThemeManager] 主题已设置: ${theme}`);
}

/**
 * 获取当前主题
 *
 * @async
 * @returns {Promise<string>} 当前主题 ('light' | 'dark' | 'glass-dark')
 */
export async function getTheme() {
  const settings = await loadData(STORAGE_KEY) || {};
  return normalizeTheme(settings.theme);
}

/**
 * 应用主题到界面
 *
 * @description
 * 默认只修改 .phone-container 的 data-theme 属性，不观察或扫描外部弹窗。
 * 调用方可向已验证的手机专属根显式应用主题，并负责其创建、更新与清理。
 * 浏览器会自动重新计算所有CSS变量，性能极佳
 *
 * @param {string} theme - 主题名称 ('light' | 'dark' | 'glass-dark')
 * @param {HTMLElement} [container] - 可选，手机容器元素（.phone-container）
 *                                    如果传入则直接使用，不传则从 document 查找
 */
export function applyTheme(theme, container) {
  theme = normalizeTheme(theme);

  // 优先使用传入的容器，否则从 document 查找
  const phoneContainer = container || document.querySelector('.phone-container');

  if (!phoneContainer) {
    logger.warn('phone','[ThemeManager] 找不到 .phone-container，跳过应用主题');
    return;
  }

  // 核心：只修改一个属性，浏览器自动重新计算CSS变量
  if (theme === THEME.DARK || theme === THEME.GLASS_DARK) {
    phoneContainer.setAttribute('data-theme', theme);
  } else {
    phoneContainer.removeAttribute('data-theme');
  }

  logger.debug('phone',`[ThemeManager] 主题已应用到DOM: ${theme}`);
}

/**
 * 保存主题到存储
 *
 * @async
 * @param {string} theme - 主题名称
 */
async function saveTheme(theme) {
  const savedSettings = await loadData(STORAGE_KEY);
  const settings = savedSettings && typeof savedSettings === 'object' && !Array.isArray(savedSettings)
    ? { ...savedSettings }
    : {};
  settings.theme = normalizeTheme(theme);
  try {
    await saveData(STORAGE_KEY, settings);
  } catch (error) {
    // saveData updates memory before its write acknowledgement; restore only our theme field.
    const live = extension_settings.acsusStandalonePhone.phone?.[STORAGE_KEY];
    if (live === settings) {
      if (savedSettings?.theme === undefined) delete live.theme;
      else live.theme = savedSettings.theme;
    }
    throw error;
  }

  logger.debug('phone',`[ThemeManager] 主题已保存: ${theme}`);
}

/**
 * 获取主题图标
 *
 * @description
 * 兼容旧切换按钮：返回切换到另一模式的图标，而非当前主题图标。
 *
 * @param {string} theme - 主题名称
 * @returns {string} Font Awesome 图标类名
 */
export function getThemeIcon(theme) {
  return normalizeTheme(theme) === THEME.LIGHT ? 'fa-moon' : 'fa-sun';
}

/**
 * 获取主题文本
 *
 * @description
 * 兼容旧切换按钮：返回切换到另一模式的文字，而非当前主题名称。
 *
 * @param {string} theme - 主题名称
 * @returns {string} 主题文字
 */
export function getThemeText(theme) {
  return normalizeTheme(theme) === THEME.LIGHT ? '夜间' : '日间';
}
