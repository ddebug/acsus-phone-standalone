import { extension_settings } from '../../standalone/phone-settings.js';
import logger from '../../logger.js';
import { PhoneAPI } from './ai-integration/ai-send-controller.js';

// Adapted from Acsus-Paws-Puffs (AcSus / 白沉 & 溯); see the retained LICENSE.
const EXT_ID = 'acsusStandalonePhone';
const MODULE_NAME = 'phone';

/** The settings lifecycle and the (lazy) runtime lifecycle are deliberately separate. */
export class PhoneSystem {
  constructor() {
    this.api = null;
    this.enabled = false;
    this.initialized = false;
    this.runtimeInitialized = false;
    this.initPromise = null;
    this.runtimePromise = null;
    this.apiInitialized = false;
    this.rollbackInitializers = new Set();
    this.membershipsChecked = false;
    this.themeInitialized = false;
  }

  /** Concurrent callers share initialization; a failed attempt can be retried. */
  init() {
    if (this.initialized) return Promise.resolve(this);
    if (this.initPromise) return this.initPromise;
    this.initPromise = Promise.resolve().then(async () => {
      this.loadSettings();
      if (this.enabled) await this.ensureRuntime();
      this.initialized = true;
      return this;
    }).catch(error => {
      this.initPromise = null;
      logger.error('phone', '[PhoneSystem] 初始化失败:', error);
      throw error;
    });
    return this.initPromise;
  }

  /**
   * Called on initial enable AND on disabled -> enabled transitions.
   * Registered rollback handlers have no lifecycle destroy API. Keep their
   * registry once, rather than pretending that disable tears them down.
   */
  ensureRuntime() {
    if (this.runtimeInitialized) return Promise.resolve(this);
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = Promise.resolve().then(async () => {
      if (!this.api) this.api = new PhoneAPI();
      if (!this.apiInitialized) {
        await this.api.init();
        this.apiInitialized = true;
      }
      const modules = await Promise.all([
        import('./plans/plan-rollback-handler.js'),
        import('./profile/signature-rollback-handler.js'),
        import('./transfers/transfer-rollback-handler.js'),
        import('./plans/plan-story-rollback-handler.js'),
        import('./messages/friend-request-rollback-handler.js'),
        import('./membership/gift-membership-rollback-handler.js')
      ]);
      const names = [
        'initPlanRollbackHandler', 'initSignatureRollbackHandler',
        'initTransferRollbackHandler', 'initPlanStoryRollbackHandler',
        'initFriendRequestRollbackHandler', 'initGiftMembershipRollbackHandler'
      ];
      for (let index = 0; index < names.length; index++) {
        const name = names[index];
        if (!this.rollbackInitializers.has(name)) {
          await modules[index][name]();
          this.rollbackInitializers.add(name);
        }
      }
      if (!this.membershipsChecked) {
        const { checkAllMembershipsExpiry } = await import('./data-storage/storage-membership.js');
        await checkAllMembershipsExpiry();
        this.membershipsChecked = true;
      }
      if (!this.themeInitialized) {
        const { initTheme } = await import('./utils/theme-manager.js');
        await initTheme();
        this.themeInitialized = true;
      }
      this.runtimeInitialized = true;
      return this;
    }).catch(error => {
      this.runtimePromise = null;
      logger.error('phone', '[PhoneSystem] 运行时初始化失败:', error);
      throw error;
    });
    return this.runtimePromise;
  }

  loadSettings() {
    extension_settings[EXT_ID] ??= {};
    extension_settings[EXT_ID][MODULE_NAME] ??= { enabled: true };
    this.enabled = extension_settings[EXT_ID][MODULE_NAME].enabled !== false;
  }
}

let phoneSystemInstance = null;

export function initPhoneSystem() {
  if (!phoneSystemInstance) phoneSystemInstance = new PhoneSystem();
  // Always await the instance's promise, even if another caller created it.
  return phoneSystemInstance.init();
}

export function getPhoneSystem() {
  return phoneSystemInstance;
}
