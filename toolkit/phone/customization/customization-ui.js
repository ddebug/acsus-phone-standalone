/**
 * 个性装扮页面
 *
 * @description
 * 提供聊天气泡装扮商店：分类筛选、气泡预览、购买与会员价。
 * 主题、头像挂件、字体等其余装扮类型尚未实现，因此页面只保留气泡入口。
 *
 * @file customization-ui.js
 */

import logger from '../../../logger.js';
import { BUBBLE_CATEGORIES } from './customization-config.js';
import { calculatePrice, generatePriceHTML } from './customization-pricing.js';
import { stateManager } from '../utils/state-manager.js';
import { showConfirmPopup, showCustomPopupWithData } from '../utils/popup-helper.js';

/**
 * 渲染个性装扮页面
 *
 * @description
 * 当前只实现聊天气泡，页面不再提供其它装扮类型入口
 *
 * @returns {Promise<DocumentFragment>} 页面DOM片段
 */
export async function renderCustomizationPage() {
  logger.info('phone','[Customization] 渲染个性装扮页面');

  const fragment = document.createDocumentFragment();
  const container = document.createElement('div');
  container.className = 'customization-wrapper';

  // 渲染页面结构
  container.innerHTML = `
    <div class="customization-topbar">
      <button class="customization-back-btn">
        <i class="fa-solid fa-chevron-left"></i>
      </button>
      <div class="customization-title">个性装扮</div>
    </div>

    <div class="customization-content">
      <div class="customization-tab-content active" data-content="bubble">
        <!-- 气泡分类列表 -->
        <div class="customization-bubble-categories"></div>
      </div>
    </div>
  `;

  // 绑定返回按钮
  bindBackButton(container);

  // 渲染气泡分类列表
  await renderBubbleCategories(container);

  fragment.appendChild(container);
  return fragment;
}

/**
 * 绑定返回按钮事件
 *
 * @param {HTMLElement} container - 页面容器
 */
function bindBackButton(container) {
  const backBtn = container.querySelector('.customization-back-btn');
  backBtn.addEventListener('click', () => {
    logger.info('phone','[Customization] 点击返回按钮');
    const overlay = document.querySelector('.phone-overlay');
    import('../phone-main-ui.js').then(({ hidePage }) => {
      hidePage(overlay, 'customization');
    });
  });
}

/**
 * 渲染气泡分类列表
 *
 * @description
 * 1. 顶部：标签栏（横向滚动，包含全部和各个分类）
 * 2. 下方：气泡网格（点击标签切换显示）
 *
 * @param {HTMLElement} container - 页面容器
 */
async function renderBubbleCategories(container) {
  logger.debug('phone','[Customization] 渲染气泡分类列表');

  const categoriesContainer = container.querySelector('.customization-bubble-categories');

  // 1. 渲染标签栏
  const filterSection = createFilterSection();
  categoriesContainer.appendChild(filterSection);

  // 2. 渲染气泡网格容器
  const gridSection = createGridSection();
  categoriesContainer.appendChild(gridSection);

  // 3. 默认显示"全部"
  await renderBubbleGrid(gridSection, 'all');

  // 4. 订阅用户会员数据变化
  const pageId = 'customization';
  // 🔥 修复：键名必须与 stateManager.set 保持一致（都用 'userMembership'）
  stateManager.subscribe(pageId, 'userMembership', async (meta) => {
    logger.info('phone','[Customization] 收到会员数据变化通知', meta);

    // 检查页面是否还存在
    if (!document.contains(container)) {
      logger.debug('phone','[Customization] 页面已关闭，跳过刷新');
      return;
    }

    // 刷新所有气泡的价格
    await refreshAllPrices();

    logger.debug('phone','[Customization] 价格已自动更新');
  });

  // 监听页面移除，自动清理订阅
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        if (node === container || node.contains?.(container)) {
          stateManager.unsubscribeAll(pageId);
          observer.disconnect();
          logger.debug('phone','[Customization] 页面已关闭，已清理订阅');
          return;
        }
      }
    }
  });

  const parent = container.parentElement;
  if (parent) {
    observer.observe(parent, { childList: true, subtree: true });
  }

  logger.debug('phone','[Customization] 已订阅用户会员数据变化');

  logger.info('phone','[Customization] 气泡列表渲染完成');
}

/**
 * 刷新所有气泡的价格
 *
 * @description
 * 会员状态变化时调用，重新计算并更新所有显示的气泡价格
 */
async function refreshAllPrices() {
  logger.debug('phone','[Customization] 刷新所有气泡价格');

  // 获取所有已渲染的气泡包装器
  const allWrappers = document.querySelectorAll('.customization-bubble-wrapper[data-bubble-id]');

  // 遍历每个气泡，重新计算价格
  for (const wrapper of allWrappers) {
    const bubbleId = wrapper.dataset.bubbleId;

    // 找到对应的气泡配置
    let bubbleConfig = null;
    for (const category of Object.values(BUBBLE_CATEGORIES)) {
      bubbleConfig = category.bubbles.find(b => b.id === bubbleId);
      if (bubbleConfig) break;
    }

    if (!bubbleConfig) continue;

    // 重新计算价格
    const priceInfo = await calculatePrice(bubbleConfig, 'bubble');
    const priceHTML = generatePriceHTML(priceInfo);

    // 更新价格DOM
    const priceElement = wrapper.querySelector('.customization-bubble-price');
    if (priceElement) {
      priceElement.outerHTML = priceHTML;
    }
  }

  logger.info('phone','[Customization] 价格刷新完成');
}

/**
 * 创建标签栏（筛选器）
 *
 * @description
 * 横向滚动的标签，包含"全部"和各个气泡分类
 * 点击标签切换气泡显示
 *
 * @returns {HTMLElement} 标签栏元素
 */
function createFilterSection() {
  const section = document.createElement('div');
  section.className = 'customization-filter-section';

  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'customization-filter-tabs';

  // 获取所有分类（排除自定义）
  const categories = Object.values(BUBBLE_CATEGORIES).filter(cat => cat.id !== 'custom');

  // 添加"全部"标签
  const allTab = createFilterTab('all', '全部', true);
  tabsContainer.appendChild(allTab);

  // 添加各个分类标签
  categories.forEach(category => {
    const tab = createFilterTab(category.id, category.name, false);
    tabsContainer.appendChild(tab);
  });

  section.appendChild(tabsContainer);
  return section;
}

/**
 * 创建单个筛选标签
 *
 * @param {string} id - 分类ID
 * @param {string} name - 分类名称
 * @param {boolean} active - 是否激活
 * @returns {HTMLElement} 标签元素
 */
function createFilterTab(id, name, active) {
  const tab = document.createElement('button');
  tab.className = 'customization-filter-tab';
  tab.dataset.categoryId = id;
  tab.textContent = name;

  if (active) {
    tab.classList.add('active');
  }

  // 绑定点击事件
  tab.addEventListener('click', () => {
    logger.debug('phone',`[Customization] 切换标签: ${name}`);

    // 更新标签激活状态
    const allTabs = tab.parentElement.querySelectorAll('.customization-filter-tab');
    allTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    // 更新气泡网格显示
    const gridSection = document.querySelector('.customization-grid-section');
    if (gridSection) {
      renderBubbleGrid(gridSection, id);
    }
  });

  return tab;
}

/**
 * 创建气泡网格容器
 *
 * @returns {HTMLElement} 网格容器元素
 */
function createGridSection() {
  const section = document.createElement('div');
  section.className = 'customization-grid-section';

  const grid = document.createElement('div');
  grid.className = 'customization-bubble-grid';

  section.appendChild(grid);
  return section;
}

/**
 * 渲染气泡网格
 *
 * @description
 * 根据选中的分类ID，显示对应的所有气泡（3列网格）
 *
 * @param {HTMLElement} gridSection - 网格容器
 * @param {string} categoryId - 分类ID（'all'表示全部）
 */
async function renderBubbleGrid(gridSection, categoryId) {
  const grid = gridSection.querySelector('.customization-bubble-grid');
  grid.innerHTML = ''; // 清空旧内容

  let bubbles = [];

  if (categoryId === 'all') {
    // 显示所有非自定义气泡
    const categories = Object.values(BUBBLE_CATEGORIES).filter(cat => cat.id !== 'custom');
    bubbles = categories.flatMap(cat => cat.bubbles);
  } else {
    // 显示指定分类的气泡
    const category = BUBBLE_CATEGORIES[categoryId];
    if (category) {
      bubbles = category.bubbles;
    }
  }

  // 渲染气泡（异步创建）
  for (const bubble of bubbles) {
    const item = await createBubbleItem(bubble);
    grid.appendChild(item);
  }

  logger.debug('phone',`[Customization] 网格显示 ${bubbles.length} 个气泡`);
}

/**
 * 创建气泡装扮项
 *
 * @description
 * 正方形卡片，只显示右侧（用户发送）气泡样式
 * 点击气泡触发购买流程
 * 价格显示在白框下方，根据会员等级动态计算
 *
 * @param {Object} bubble - 气泡配置
 * @param {string} bubble.id - 气泡ID
 * @param {string} bubble.name - 气泡名称
 * @param {number} bubble.price - 价格
 * @param {string} bubble.type - 类型（pure/image）
 * @param {Object} bubble.css - CSS规则
 * @returns {Promise<HTMLElement>} 气泡项元素
 */
async function createBubbleItem(bubble) {
  const wrapper = document.createElement('div');
  wrapper.className = 'customization-bubble-wrapper';
  wrapper.dataset.bubbleId = bubble.id; // 添加ID，方便后续刷新

  const item = document.createElement('div');
  item.className = 'customization-bubble-item';
  item.dataset.bubbleId = bubble.id;
  item.dataset.bubbleName = bubble.name;
  item.dataset.bubblePrice = String(bubble.price);

  item.innerHTML = `
    <div class="customization-bubble-preview">
      <div class="customization-bubble-sample" style="${getCSSString(bubble.css)}">
        大家好！
      </div>
    </div>
  `;

  // 计算价格并生成HTML
  const priceInfo = await calculatePrice(bubble, 'bubble');
  const priceHTML = generatePriceHTML(priceInfo);

  // 创建价格容器
  const priceContainer = document.createElement('div');
  priceContainer.innerHTML = priceHTML;

  wrapper.appendChild(item);
  wrapper.appendChild(priceContainer.firstElementChild); // 只添加实际的价格元素

  // 绑定点击购买事件（点击整个包装器）
  bindBubbleClick(wrapper, bubble);

  return wrapper;
}

/**
 * 绑定气泡点击事件
 *
 * @param {HTMLElement} item - 气泡项元素
 * @param {Object} bubble - 气泡配置
 */
function bindBubbleClick(item, bubble) {
  item.addEventListener('click', () => {
    logger.info('phone',`[Customization] 点击气泡: ${bubble.name}`);
    handleBubbleClick(bubble);
  });
}

/**
 * 处理气泡点击事件
 *
 * @description
 * 根据是否已购买，显示不同的弹窗：
 * - 未购买：显示购买确认弹窗
 * - 已购买：显示应用设置弹窗
 *
 * @param {Object} bubble - 气泡配置
 */
async function handleBubbleClick(bubble) {
  logger.debug('phone','[Customization] 点击气泡:', bubble.name);

  // 动态导入购买模块
  const { isItemOwned } = await import('./customization-purchase.js');

  // 检查是否已购买
  const owned = await isItemOwned(bubble.id);

  if (owned) {
    // 已购买：显示应用设置弹窗
    showApplyDialog(bubble);
  } else {
    // 未购买：显示购买确认弹窗
    showPurchaseDialog(bubble);
  }
}

/**
 * 显示购买确认弹窗
 *
 * @description
 * 显示气泡预览和价格信息，确认后执行购买
 * 使用 popup-helper 的 showConfirmPopup 封装
 *
 * @param {Object} bubble - 气泡配置
 */
async function showPurchaseDialog(bubble) {
  const { checkPurchaseEligibility, purchaseItem } = await import('./customization-purchase.js');
  const { calculatePrice, generatePriceHTML } = await import('./customization-pricing.js');
  const { getBalance } = await import('../data-storage/storage-wallet.js');

  // 检查购买资格
  const eligibility = await checkPurchaseEligibility(bubble, 'bubble');
  const balance = await getBalance();
  const priceInfo = await calculatePrice(bubble, 'bubble');

  // 创建弹窗内容
  const content = `
    <div class="customization-purchase-dialog">
      <div class="customization-bubble-preview-large">
        <div class="customization-bubble-sample" style="${getCSSString(bubble.css)}">
          大家好！
        </div>
      </div>
      <div class="customization-purchase-info">
        <div class="customization-purchase-name">${bubble.name}</div>
        <div class="customization-purchase-price">${priceInfo.priceLabel}</div>
        <div class="customization-purchase-balance">当前余额：¥${balance}</div>
      </div>
    </div>
  `;

  // 显示确认弹窗
  const confirmed = await showConfirmPopup('购买气泡', content, {
    okButton: '确认购买',
    cancelButton: '取消'
  });

  if (!confirmed) {
    logger.debug('phone','[Customization] 用户取消购买');
    return;
  }

  // 执行购买
  const result = await purchaseItem(bubble, 'bubble');

  if (result.success) {
    toastr.success(result.message);
    logger.info('phone','[Customization] 购买成功:', bubble.name);

    // 刷新价格显示
    await refreshAllPrices();
  } else {
    toastr.error(result.message);
    logger.warn('phone','[Customization] 购买失败:', result.message);
  }
}

/**
 * 显示应用设置弹窗
 *
 * @description
 * 全局装扮页面：点击已购买气泡，直接应用为"所有对话中用户的气泡"
 * 简化设计：不需要选择作用范围，直接应用
 *
 * @param {Object} bubble - 气泡配置
 */
async function showApplyDialog(bubble) {
  const { applyBubbleTheme } = await import('./customization-apply.js');

  // 创建弹窗内容
  const content = `
    <div class="customization-apply-dialog">
      <div class="customization-bubble-preview-large">
        <div class="customization-bubble-sample" style="${getCSSString(bubble.css)}">
          大家好！
        </div>
      </div>
      <div class="customization-apply-info">
        <div class="customization-apply-name">${bubble.name}</div>
        <div class="customization-apply-hint" style="color: var(--phone-text-secondary); font-size: 0.875em; margin-top: 0.5em;">
          将应用为所有对话中你的消息气泡样式
        </div>
      </div>
    </div>
  `;

  // 显示确认弹窗
  const confirmed = await showConfirmPopup('应用气泡', content, {
    okButton: '应用所有对话',
    cancelButton: '取消'
  });

  if (!confirmed) {
    logger.debug('phone','[Customization] 用户取消应用');
    return;
  }

  // 应用装扮（全局，作用于所有对话中用户的气泡）
  await applyBubbleTheme(bubble.id, { type: 'all' });

  toastr.success('气泡已应用到所有对话！');
  logger.info('phone','[Customization] 气泡已应用:', bubble.name, '作用范围: 所有对话');
}


/**
 * 将CSS对象转换为字符串
 *
 * @param {Object} cssObj - CSS规则对象
 * @returns {string} CSS字符串
 *
 * @example
 * getCSSString({background: 'red', color: 'white'})
 * // 返回: "background: red; color: white;"
 */
function getCSSString(cssObj) {
  return Object.entries(cssObj)
    .map(([key, value]) => {
      // 转换驼峰命名为短横线命名
      const cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      return `${cssKey}: ${value}`;
    })
    .join('; ');
}
