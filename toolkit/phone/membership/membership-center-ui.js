/**
 * 会员中心页面UI
 *
 * @description
 * 显示当前会员状态、购买/续费会员
 *
 * @module membership-center-ui
 */

import logger from '../../../logger.js';
import { getUserMembership, grantUserMembership } from '../data-storage/storage-membership.js';
import { getBalance, subtractBalance } from '../data-storage/storage-wallet.js';
import { showSuccessToast, showErrorToast } from '../ui-components/toast-notification.js';
import { showConfirmPopup } from '../utils/popup-helper.js';
import { stateManager } from '../utils/state-manager.js';

// 会员价格配置（年付9折：10*12*0.9=108，20*12*0.9=216）
const MEMBERSHIP_PRICES = {
  vip_month: { price: 10, duration: 30, label: 'VIP月付', type: 'vip' },
  vip_year: { price: 108, duration: 365, label: 'VIP年付', type: 'vip' },
  svip_month: { price: 20, duration: 30, label: 'SVIP月付', type: 'svip' },
  svip_year: { price: 216, duration: 365, label: 'SVIP年付', type: 'annual-svip' }
};

/**
 * 渲染会员中心页面
 *
 * @async
 * @param {HTMLElement} container - 容器元素
 */
export async function renderMembershipCenter(container) {
  logger.info('phone','[MembershipCenter]] 渲染会员中心页面');

  // 清空容器
  container.innerHTML = '';
  container.className = 'phone-page membership-center-page';

  // 创建顶部导航栏
  const header = createHeader();
  container.appendChild(header);

  // 读取用户会员数据
  const membership = await getUserMembership();
  const balance = await getBalance();

  // 创建页面内容
  const content = document.createElement('div');
  content.className = 'membership-center-content';

  // 会员状态卡片
  content.appendChild(createMembershipStatusCard(membership));

  // 购买会员区域
  content.appendChild(createPurchaseSection(membership, balance));

  // 功能说明（标签切换）
  content.appendChild(createFeaturesSection());

  container.appendChild(content);

  // ✅ 注册监听器：会员数据变化时自动刷新
  setupMembershipChangeListener(container);

  logger.debug('phone','[MembershipCenter]] 页面渲染完成');
}

/**
 * 创建顶部导航栏
 *
 * @returns {HTMLElement}
 */
function createHeader() {
  const header = document.createElement('div');
  header.className = 'membership-center-topbar';
  header.innerHTML = `
    <button class="membership-center-back-btn">
      <i class="fa-solid fa-chevron-left"></i>
    </button>
    <div class="membership-center-title">会员中心</div>
  `;

  // 绑定返回按钮事件
  const backBtn = header.querySelector('.membership-center-back-btn');
  backBtn.addEventListener('click', handleBack);

  return header;
}

/**
 * 处理返回
 */
function handleBack() {
  logger.info('phone','[MembershipCenter]] 点击返回');
  const overlayElement = document.querySelector('.phone-overlay');
  if (overlayElement) {
    import('../phone-main-ui.js').then(({ hidePage }) => {
      hidePage(overlayElement, 'membership-center');
    });
  }
}

/**
 * 创建会员状态卡片
 *
 * @param {Object} membership - 会员数据
 * @returns {HTMLElement}
 */
function createMembershipStatusCard(membership) {
  const card = document.createElement('div');
  card.className = 'membership-status-card';

  const now = Math.floor(Date.now() / 1000);
  const isActive = membership.type !== 'none' && membership.expireTime > now;

  if (isActive) {
    // 有会员
    const remainingDays = Math.ceil((membership.expireTime - now) / 86400);
    const expireDate = new Date(membership.expireTime * 1000).toLocaleDateString('zh-CN');

    let typeText = '';
    let typeClass = '';
    switch (membership.type) {
      case 'vip':
        typeText = 'VIP会员';
        typeClass = 'vip';
        break;
      case 'svip':
        typeText = 'SVIP会员';
        typeClass = 'svip';
        break;
      case 'annual-svip':
        typeText = '年SVIP会员';
        typeClass = 'svip';
        break;
    }

    let queueHTML = '';
    // ✅ 显示队列信息（自动合并相同类型）
    if (membership.queue && membership.queue.length > 0) {
      // 🔥 合并相同类型的会员（用于显示）
      const mergedQueue = {};
      membership.queue.forEach(item => {
        if (!mergedQueue[item.type]) {
          mergedQueue[item.type] = 0;
        }
        mergedQueue[item.type] += item.duration;
      });

      // 生成队列显示文本（合并到一行）
      const queueItems = [];
      for (const [type, totalDuration] of Object.entries(mergedQueue)) {
        const queueTypeText = type === 'vip' ? 'VIP' : (type === 'svip' ? 'SVIP' : '年SVIP');
        queueItems.push(`${queueTypeText} ${totalDuration}天`);
      }

      // 使用统一的 membership-status-row 结构
      queueHTML = `
        <div class="membership-status-row">
          <span class="label">待生效会员：</span>
          <span class="value">${queueItems.join('、')}</span>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="membership-status-header ${typeClass}">
        <i class="fa-solid fa-crown"></i>
        <span>${typeText}</span>
      </div>
      <div class="membership-status-info">
        <div class="membership-status-row">
          <span class="label">到期时间：</span>
          <span class="value">${expireDate}</span>
        </div>
        <div class="membership-status-row">
          <span class="label">剩余天数：</span>
          <span class="value">${remainingDays} 天</span>
        </div>
        ${queueHTML}
      </div>
    `;
  } else {
    // 无会员
    card.innerHTML = `
      <div class="membership-status-header inactive">
        <i class="fa-solid fa-crown"></i>
        <span>暂无会员</span>
      </div>
      <div class="membership-status-info">
        <p class="membership-hint">开通会员，享受更多特权服务</p>
      </div>
    `;
  }

  return card;
}

/**
 * 创建购买会员区域
 *
 * @param {Object} membership - 会员数据
 * @param {number} balance - 余额
 * @returns {HTMLElement}
 */
function createPurchaseSection(membership, balance) {
  const section = document.createElement('div');
  section.className = 'membership-purchase-section';

  const title = document.createElement('h3');
  title.className = 'membership-section-title';
  title.textContent = '开通/续费会员';
  section.appendChild(title);

  // 余额显示
  const balanceDiv = document.createElement('div');
  balanceDiv.className = 'membership-balance';
  balanceDiv.innerHTML = `
    <span>当前余额：</span>
    <span class="balance-amount">¥${balance.toFixed(2)}</span>
  `;
  section.appendChild(balanceDiv);

  // VIP选项
  const vipGroup = document.createElement('div');
  vipGroup.className = 'membership-tier-group';
  vipGroup.innerHTML = `
    <div class="membership-tier-header vip">
      <i class="fa-solid fa-crown"></i>
      <span>VIP会员</span>
    </div>
  `;

  const vipOptions = document.createElement('div');
  vipOptions.className = 'membership-options';

  vipOptions.appendChild(createOptionButton('vip_month', balance));
  vipOptions.appendChild(createOptionButton('vip_year', balance));

  vipGroup.appendChild(vipOptions);
  section.appendChild(vipGroup);

  // SVIP选项
  const svipGroup = document.createElement('div');
  svipGroup.className = 'membership-tier-group';
  svipGroup.innerHTML = `
    <div class="membership-tier-header svip">
      <i class="fa-solid fa-crown"></i>
      <span>SVIP会员</span>
    </div>
  `;

  const svipOptions = document.createElement('div');
  svipOptions.className = 'membership-options';

  svipOptions.appendChild(createOptionButton('svip_month', balance));
  svipOptions.appendChild(createOptionButton('svip_year', balance));

  svipGroup.appendChild(svipOptions);
  section.appendChild(svipGroup);

  return section;
}

/**
 * 创建购买选项按钮
 *
 * @param {string} optionKey - 选项键名
 * @param {number} balance - 余额
 * @returns {HTMLElement}
 */
function createOptionButton(optionKey, balance) {
  const option = MEMBERSHIP_PRICES[optionKey];
  const canAfford = balance >= option.price;

  const button = document.createElement('button');
  button.className = `membership-option-btn ${!canAfford ? 'disabled' : ''}`;
  button.dataset.option = optionKey;

  const durationText = option.duration === 30 ? '1个月' : '1年';
  const discountTag = option.duration === 365 ? '<span class="discount-tag">9折</span>' : '';

  button.innerHTML = `
    <div class="option-info">
      <div class="option-label">${option.label}${discountTag}</div>
      <div class="option-duration">${durationText}</div>
    </div>
    <div class="option-price">¥${option.price}</div>
  `;

  button.addEventListener('click', () => handlePurchaseMembership(optionKey));

  return button;
}

/**
 * 创建功能说明区域
 *
 * @returns {HTMLElement}
 */
function createFeaturesSection() {
  const section = document.createElement('div');
  section.className = 'membership-features-section';

  const title = document.createElement('h3');
  title.className = 'membership-section-title';
  title.textContent = '会员特权';
  section.appendChild(title);

  // 标签切换
  const tabs = document.createElement('div');
  tabs.className = 'membership-tabs';
  tabs.innerHTML = `
    <button class="membership-tab active" data-tab="vip">VIP</button>
    <button class="membership-tab" data-tab="svip">SVIP</button>
    <button class="membership-tab" data-tab="annual">年SVIP</button>
  `;
  section.appendChild(tabs);

  // 内容区
  const tabContent = document.createElement('div');
  tabContent.className = 'membership-tab-content';
  tabContent.innerHTML = `
    <div class="membership-feature-panel active" data-panel="vip">
      <ul class="membership-feature-list">
        <li><i class="fa-solid fa-check"></i> 和角色聊天时，等级增长少量变快</li>
        <li><i class="fa-solid fa-check"></i> 装扮打折购买</li>
        <li><i class="fa-solid fa-check"></i> 每天可以免费更换一次装扮</li>
      </ul>
    </div>
    <div class="membership-feature-panel" data-panel="svip">
      <ul class="membership-feature-list">
        <li><i class="fa-solid fa-check"></i> 和角色聊天时，等级增长变快</li>
        <li><i class="fa-solid fa-check"></i> 装扮随便用（会员期间）</li>
      </ul>
    </div>
    <div class="membership-feature-panel" data-panel="annual">
      <ul class="membership-feature-list">
        <li><i class="fa-solid fa-check"></i> 年费会员，最大化增加等级</li>
        <li><i class="fa-solid fa-check"></i> 装扮随便用（会员期间）</li>
      </ul>
    </div>
  `;
  section.appendChild(tabContent);

  // 绑定标签切换事件
  tabs.querySelectorAll('.membership-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;

      // 切换标签激活状态
      tabs.querySelectorAll('.membership-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // 切换内容面板
      tabContent.querySelectorAll('.membership-feature-panel').forEach(panel => {
        panel.classList.remove('active');
      });
      tabContent.querySelector(`[data-panel="${tabName}"]`).classList.add('active');
    });
  });

  return section;
}

/**
 * 处理购买会员
 *
 * @async
 * @param {string} optionKey - 选项键名
 */
async function handlePurchaseMembership(optionKey) {
  const option = MEMBERSHIP_PRICES[optionKey];

  try {
    // 检查余额
    const balance = await getBalance();
    if (balance < option.price) {
      showErrorToast('余额不足，请先充值');
      return;
    }

    // 确认购买
    const confirmed = await showConfirmPopup(
      '确认购买',
      `确定要购买${option.label}吗？\n\n价格：¥${option.price}\n时长：${option.duration}天`,
      { okButton: '确认购买', cancelButton: '取消' }
    );

    if (!confirmed) return;

    // 扣除余额
    await subtractBalance(option.price);

    // 开通/续费会员
    await grantUserMembership(option.type, option.duration, {
      from: 'self',
      price: option.price
    });

    showSuccessToast(`${option.label}开通成功！`);

    // 局部刷新：只更新会员状态卡片和余额显示
    await refreshMembershipStatus();
    await refreshBalanceDisplay();

    logger.info('phone','[MembershipCenter]] 购买会员成功:', option.label);
  } catch (error) {
    logger.error('phone','[MembershipCenter]] 购买会员失败:', error);
    showErrorToast('购买失败，请稍后重试');
  }
}

/**
 * 局部刷新：只更新会员状态卡片
 *
 * @async
 */
async function refreshMembershipStatus() {
  logger.debug('phone','[MembershipCenter]] 刷新会员状态卡片');

  const statusCard = document.querySelector('.membership-status-card');
  if (!statusCard) {
    logger.warn('phone','[MembershipCenter]] 未找到会员状态卡片');
    return;
  }

  // 重新读取会员数据
  const membership = await getUserMembership();

  // 创建新的卡片内容
  const newCard = createMembershipStatusCard(membership);

  // 替换旧卡片
  statusCard.replaceWith(newCard);

  logger.debug('phone','[MembershipCenter]] 会员状态卡片已更新');
}

/**
 * 局部刷新：只更新余额显示
 *
 * @async
 */
async function refreshBalanceDisplay() {
  logger.debug('phone','[MembershipCenter]] 刷新余额显示');

  const balanceElement = document.querySelector('.balance-amount');
  if (!balanceElement) {
    logger.warn('phone','[MembershipCenter]] 未找到余额元素');
    return;
  }

  // 重新读取余额
  const balance = await getBalance();

  // 更新显示
  balanceElement.textContent = `¥${balance.toFixed(2)}`;

  logger.debug('phone','[MembershipCenter]] 余额显示已更新:', balance);
}

/**
 * 设置会员数据变化监听器
 *
 * @description
 * 订阅 userMembership 状态变化，自动刷新会员状态卡片
 * 当角色送用户会员时，自动更新UI显示
 *
 * @param {HTMLElement} container - 页面容器
 */
function setupMembershipChangeListener(container) {
  const pageId = 'membership-center';

  // 订阅用户会员数据变化
  // 🔥 修复：键名必须与 stateManager.set 保持一致（都用 'userMembership'）
  stateManager.subscribe(pageId, 'userMembership', async (meta) => {
    logger.info('phone','[MembershipCenter]] 收到会员数据变化通知', meta);

    // 检查页面是否还存在
    if (!document.contains(container)) {
      logger.debug('phone','[MembershipCenter]] 页面已关闭，跳过刷新');
      return;
    }

    // 刷新会员状态卡片
    await refreshMembershipStatus();

    logger.debug('phone','[MembershipCenter]] 会员状态已自动更新');
  });

  // 监听页面移除，自动清理订阅
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        if (node === container || node.contains?.(container)) {
          stateManager.unsubscribeAll(pageId);
          observer.disconnect();
          logger.debug('phone','[MembershipCenter]] 页面已关闭，已清理订阅');
          return;
        }
      }
    }
  });

  const parent = container.parentElement;
  if (parent) {
    observer.observe(parent, { childList: true, subtree: true });
  }

  logger.debug('phone','[MembershipCenter]] 已订阅会员数据变化');
}
