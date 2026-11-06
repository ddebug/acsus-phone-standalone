// Run: node --experimental-vm-modules --test tests/lifecycle.test.mjs
// Source-only sandbox: synthetic host, isolated in-memory records, no user data/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const MENU_ID = 'acsus-standalone-phone-menu-entry';
const HANDLERS = [
  ['plans/plan-rollback-handler.js', 'initPlanRollbackHandler'],
  ['profile/signature-rollback-handler.js', 'initSignatureRollbackHandler'],
  ['transfers/transfer-rollback-handler.js', 'initTransferRollbackHandler'],
  ['plans/plan-story-rollback-handler.js', 'initPlanStoryRollbackHandler'],
  ['messages/friend-request-rollback-handler.js', 'initFriendRequestRollbackHandler'],
  ['membership/gift-membership-rollback-handler.js', 'initGiftMembershipRollbackHandler']
];

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createDocument(hasMenu) {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.id = '';
      this.className = '';
      this.style = {};
      this.children = [];
      this.listeners = new Map();
      this.parentNode = null;
    }
    appendChild(child) {
      child.remove();
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
      }
    }
    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }
  }
  const body = new Element('body');
  function all() {
    const walk = element => [element, ...element.children.flatMap(walk)];
    return walk(body);
  }
  const document = {
    body,
    events: [],
    createElement: tag => new Element(tag),
    getElementById: id => all().find(element => element.id === id) || null,
    querySelector(selector) {
      if (selector.startsWith('#')) return this.getElementById(selector.slice(1));
      if (selector.startsWith('.')) return all().find(element => element.className.split(' ').includes(selector.slice(1))) || null;
      throw new Error(`Unexpected selector ${selector}`);
    },
    querySelectorAll(selector) {
      if (selector.startsWith('#')) return all().filter(element => element.id === selector.slice(1));
      if (selector.startsWith('.')) return all().filter(element => element.className.split(' ').includes(selector.slice(1)));
      throw new Error(`Unexpected selector ${selector}`);
    },
    dispatchEvent(event) { this.events.push(event); return true; },
    addMenu() {
      const menu = new Element('div');
      menu.id = 'extensionsMenu';
      body.appendChild(menu);
      return menu;
    }
  };
  if (hasMenu) document.addMenu();
  return document;
}

async function harness(options = {}) {
  const counts = { apiConstruct: 0, apiInit: 0, abort: 0, register: 0, unregister: 0,
    expiry: 0, theme: 0, render: 0, close: 0, save: 0, fetch: 0, handlers: {}, states: [] };
  const settings = { acsusStandalonePhone: { phone: { enabled: options.enabled ?? true, ...(options.phone || {}) } } };
  const document = createDocument(options.menu !== false);
  const listeners = new Map();
  const eventSource = {
    on(name, fn) { const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set); },
    once(name, fn) { const wrapped = (...args) => { this.off(name, wrapped); fn(...args); }; wrapped.original = fn; this.on(name, wrapped); },
    off(name, fn) { const set = listeners.get(name); for (const candidate of set || []) if (candidate === fn || candidate.original === fn) set.delete(candidate); },
    emit(name) { for (const listener of [...(listeners.get(name) || [])]) listener(); },
    listenerCount(name) { return listeners.get(name)?.size || 0; }
  };
  const context = vm.createContext({ document, console,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    fetch() { counts.fetch++; throw new Error('Network forbidden in lifecycle tests'); }
  });
  const noop = () => {};
  const overrides = new Map();
  function fixture(path, exports) { overrides.set(new URL(path, ROOT).href, exports); }
  fixture('standalone/phone-settings.js', {
    extension_settings: settings,
    saveSettingsDebounced: async () => { counts.save++; await options.save?.(); }
  });
  fixture('logger.js', { default: { info: noop, warn: noop, error: noop, debug: noop } });
  overrides.set(new URL('/script.js', ROOT).href, { eventSource, event_types: { APP_READY: 'ready' } });
  fixture('toolkit/phone/phone-main-ui.js', {
    renderPhoneFrame() { counts.render++; const element = document.createElement('div'); element.className = 'phone-overlay'; return element; },
    closePhoneUI() { counts.close++; document.querySelector('.phone-overlay')?.remove(); }
  });
  fixture('toolkit/phone/ai-integration/ai-send-controller.js', {
    PhoneAPI: class {
      constructor() { counts.apiConstruct++; }
      async init() { counts.apiInit++; await options.apiInit?.(); }
      abort() { counts.abort++; }
    }
  });
  for (const [path, name] of HANDLERS) fixture(`toolkit/phone/${path}`, {
    [name]() { counts.handlers[name] = (counts.handlers[name] || 0) + 1; }
  });
  fixture('toolkit/phone/data-storage/storage-membership.js', {
    async checkAllMembershipsExpiry() { counts.expiry++; await options.expiry?.(); }
  });
  fixture('toolkit/phone/utils/theme-manager.js', {
    async initTheme() { counts.theme++; await options.theme?.(); }
  });
  fixture('toolkit/phone/utils/tavern-macros.js', {
    async registerPhoneMacros() { counts.register++; await options.register?.(); },
    async unregisterPhoneMacros() { counts.unregister++; await options.unregister?.(); }
  });
  fixture('toolkit/phone/utils/state-manager.js', {
    stateManager: { async set(...args) { counts.states.push(args); } }
  });
  const modules = new Map();
  const evaluations = new Map();
  async function load(id) {
    if (!modules.has(id)) modules.set(id, (async () => {
      if (overrides.has(id)) {
        const exports = overrides.get(id);
        return new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context, identifier: id });
      }
      assert.ok(id.startsWith(ROOT.href), `Disallowed module access: ${id}`);
      const source = await readFile(new URL(id), 'utf8');
      return new vm.SourceTextModule(source, {
        context, identifier: id,
        importModuleDynamically: async (specifier, reference) => {
          const child = await load(new URL(specifier, reference.identifier).href);
          await evaluate(child);
          return child;
        }
      });
    })());
    return modules.get(id);
  }
  async function evaluate(module) {
    if (!evaluations.has(module.identifier)) evaluations.set(module.identifier, (async () => {
      if (module.status === 'unlinked') await module.link((specifier, reference) => load(new URL(specifier, reference.identifier).href));
      if (module.status === 'linked') await module.evaluate();
      if (module.status === 'errored') throw module.error;
    })());
    await evaluations.get(module.identifier);
  }
  async function importSource(path) {
    const module = await load(new URL(path, ROOT).href);
    await evaluate(module);
    return module.namespace;
  }
  return { counts, settings, document, eventSource, importSource,
    phone: await importSource('toolkit/phone/index.js') };
}

function assertRuntimeOnce(counts) {
  assert.equal(counts.apiConstruct, 1);
  assert.equal(counts.apiInit, 1);
  assert.equal(counts.expiry, 1);
  assert.equal(counts.theme, 1);
  for (const [, name] of HANDLERS) assert.equal(counts.handlers[name], 1, name);
}

test('post-APP_READY init is concurrent/idempotent, menus and opens are deduplicated', async () => {
  const h = await harness();
  h.eventSource.emit('ready'); // Event happened before the phone module entry is called.
  const first = h.phone.initPhone();
  const second = h.phone.initPhone();
  assert.equal(first, second);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(a.initialized, true);
  assert.equal(a.runtimeInitialized, true);
  await h.phone.initPhone();
  const overlays = await Promise.all([h.phone.openPhoneUI(), h.phone.openPhoneUI()]);
  assert.equal(overlays[0], overlays[1]);
  assert.equal(h.document.querySelectorAll(`#${MENU_ID}`).length, 1);
  assert.equal(h.document.getElementById(MENU_ID).listeners.get('click').length, 1);
  assert.equal(h.counts.register, 1);
  assert.equal(h.counts.render, 1);
  assert.equal(h.eventSource.listenerCount('ready'), 0);
  assertRuntimeOnce(h.counts);
});

test('initially disabled -> enable initializes runtime once and repeat toggles do not duplicate it', async () => {
  const h = await harness({ enabled: false });
  const system = await h.phone.initPhone();
  assert.equal(system.initialized, true);
  assert.equal(system.runtimeInitialized, false);
  assert.equal(system.api, null);
  assert.equal(await h.phone.openPhoneUI(), null);
  assert.equal(h.document.getElementById(MENU_ID).style.display, 'none');
  await Promise.all([h.phone.enablePhone(), h.phone.enablePhone()]);
  assert.equal(system.enabled, true);
  assert.equal(system.runtimeInitialized, true);
  assert.equal(h.document.getElementById(MENU_ID).style.display, '');
  await h.phone.disablePhone();
  assert.equal(await h.phone.openPhoneUI(), null);
  await h.phone.disablePhone();
  assert.equal(h.counts.unregister, 1);
  await h.phone.enablePhone();
  assert.equal(h.counts.register, 2);
  assert.equal(h.settings.acsusStandalonePhone.phone.enabled, true);
  assertRuntimeOnce(h.counts);
});

test('menu absent during direct init is installed once at APP_READY, including off state', async () => {
  const h = await harness({ enabled: false, menu: false });
  await h.phone.initPhone();
  h.phone.showMenuEntry();
  h.phone.showMenuEntry();
  assert.equal(h.eventSource.listenerCount('ready'), 1);
  h.document.addMenu();
  h.eventSource.emit('ready');
  h.eventSource.emit('ready');
  assert.equal(h.eventSource.listenerCount('ready'), 0);
  assert.equal(h.document.querySelectorAll(`#${MENU_ID}`).length, 1);
  assert.equal(h.document.getElementById(MENU_ID).style.display, 'none');
  await h.phone.enablePhone();
  assert.equal(h.document.getElementById(MENU_ID).style.display, '');
});

test('disable aborts/closes/hides immediately and awaits asynchronous macro unregister', async () => {
  const gate = deferred();
  const started = deferred();
  const h = await harness({ unregister: async () => { started.resolve(); await gate.promise; } });
  const system = await h.phone.initPhone();
  await h.phone.openPhoneUI();
  let complete = false;
  const disabling = h.phone.disablePhone().then(() => { complete = true; });
  assert.equal(system.enabled, false);
  assert.ok(h.counts.abort >= 1);
  assert.equal(h.document.querySelector('.phone-overlay'), null);
  assert.equal(h.document.getElementById(MENU_ID).style.display, 'none');
  await started.promise;
  assert.equal(complete, false);
  gate.resolve();
  await disabling;
  assert.equal(complete, true);
  assert.equal(h.settings.acsusStandalonePhone.phone.enabled, false);
});

test('disable wins over an in-flight first enable; next enable reuses registered runtime', async () => {
  const apiGate = deferred();
  const started = deferred();
  const h = await harness({ enabled: false, apiInit: async () => { started.resolve(); await apiGate.promise; } });
  const system = await h.phone.initPhone();
  const enabling = h.phone.enablePhone();
  await started.promise;
  const disabling = h.phone.disablePhone();
  assert.equal(system.enabled, false);
  apiGate.resolve();
  await Promise.all([enabling, disabling]);
  assert.equal(system.enabled, false);
  assert.equal(h.counts.register, 0);
  assert.equal(await h.phone.openPhoneUI(), null);
  await h.phone.enablePhone();
  assert.equal(system.enabled, true);
  assertRuntimeOnce(h.counts);
});

test('latest queued enable after disable wins without duplicate handlers', async () => {
  const h = await harness({ enabled: false });
  await h.phone.initPhone();
  await Promise.all([h.phone.enablePhone(), h.phone.disablePhone(), h.phone.enablePhone()]);
  assert.equal(h.settings.acsusStandalonePhone.phone.enabled, true);
  assert.equal(h.document.getElementById(MENU_ID).style.display, '');
  assert.equal(h.counts.register, 1);
  assertRuntimeOnce(h.counts);
});

test('failed runtime initialization retries incomplete stages without duplicate handlers', async () => {
  let fail = true;
  const h = await harness({ theme: () => { if (fail) { fail = false; throw new Error('synthetic theme failure'); } } });
  await assert.rejects(h.phone.initPhone(), /synthetic theme failure/);
  const system = await h.phone.initPhone();
  assert.equal(system.runtimeInitialized, true);
  assert.equal(h.counts.apiConstruct, 1);
  assert.equal(h.counts.apiInit, 1);
  assert.equal(h.counts.theme, 2);
  assert.equal(h.counts.expiry, 1);
  for (const [, name] of HANDLERS) assert.equal(h.counts.handlers[name], 1);
});

test('concurrent initPhoneSystem callers share the actual pending runtime', async () => {
  const gate = deferred();
  const entered = deferred();
  const h = await harness({ apiInit: async () => { entered.resolve(); await gate.promise; } });
  const module = await h.importSource('toolkit/phone/phone-system.js');
  const first = module.initPhoneSystem();
  const second = module.initPhoneSystem();
  assert.equal(first, second);
  await entered.promise;
  assert.equal(module.getPhoneSystem().initialized, false);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assertRuntimeOnce(h.counts);
});

test('partial macro registration failure is cleaned up before retry', async () => {
  let fail = true;
  const h = await harness({ register: () => { if (fail) { fail = false; throw new Error('synthetic macro failure'); } } });
  await assert.rejects(h.phone.initPhone(), /synthetic macro failure/);
  assert.equal(h.counts.unregister, 1);
  await h.phone.initPhone();
  assert.equal(h.counts.register, 2);
  assertRuntimeOnce(h.counts);
});

test('disable during asynchronous macro registration leaves no registered macros or visible UI', async () => {
  const gate = deferred();
  const started = deferred();
  const h = await harness({ register: async () => { started.resolve(); await gate.promise; } });
  const initializing = h.phone.initPhone();
  await started.promise;
  const disabling = h.phone.disablePhone();
  gate.resolve();
  await Promise.all([initializing, disabling]);
  assert.equal(h.counts.register, 1);
  assert.equal(h.counts.unregister, 1);
  assert.equal(h.settings.acsusStandalonePhone.phone.enabled, false);
  assert.equal(await h.phone.openPhoneUI(), null);
  assert.equal(h.document.getElementById(MENU_ID).style.display, 'none');
});

test('failed enable stays off, cleans up, and a subsequent enable succeeds', async () => {
  let fail = true;
  const h = await harness({ enabled: false, theme: () => { if (fail) { fail = false; throw new Error('enable theme failure'); } } });
  await h.phone.initPhone();
  await assert.rejects(h.phone.enablePhone(), /enable theme failure/);
  assert.equal(h.settings.acsusStandalonePhone.phone.enabled, false);
  assert.equal(await h.phone.openPhoneUI(), null);
  await h.phone.enablePhone();
  assert.equal(h.settings.acsusStandalonePhone.phone.enabled, true);
  assert.equal(h.counts.apiInit, 1);
  for (const [, name] of HANDLERS) assert.equal(h.counts.handlers[name], 1);
});

test('emoji delete removes only isolated records, even when paths reference original/shared media', async () => {
  const shared = '/user/files/original-shared.png';
  const h = await harness({ enabled: false, phone: { emojis: { items: [
    { id: 'remove', name: 'old', imagePath: shared },
    { id: 'keep', name: 'still here', imagePath: shared }
  ] } } });
  const emoji = await h.importSource('toolkit/phone/emojis/emoji-manager-data.js');
  assert.equal(await emoji.deleteEmojis(['remove', 'missing']), 1);
  assert.equal(emoji.getEmojis().length, 1);
  assert.equal(emoji.getEmojis()[0].imagePath, shared);
  assert.equal(h.counts.fetch, 0);
  assert.equal(h.counts.save, 1);
  assert.equal(h.document.events.length, 1);
  assert.equal(await emoji.deleteEmojis(['remove']), 0);
  assert.equal(h.document.events.length, 1);
});

test('image deletion/migration/clear use the independent save alias and never delete physical files', async () => {
  const shared = '/user/files/original-shared.png';
  const h = await harness({ enabled: false, phone: { uploadedImages: [
    { id: 'a', filename: 'a.png', imagePath: shared },
    { id: 'b', filename: 'b.png', imagePath: shared }
  ] } });
  // /script.js intentionally does NOT export saveSettingsDebounced/getRequestHeaders.
  // Linking this actual module therefore detects a regression to the host save alias.
  const image = await h.importSource('toolkit/phone/storage/image-data.js');
  assert.equal(image.getUploadedImages().length, 2);
  assert.equal(h.counts.save, 1); // Shape migration saved into the isolated facade.
  const result = await image.deleteImages(['a.png', 'missing.png']);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.successCount, 1);
  assert.equal(result.failCount, 0);
  assert.equal(result.physicalFilesRetained, true);
  assert.equal(image.getUploadedImages()[0].imagePath, shared);
  assert.equal(h.counts.states[0][2].physicalFilesRetained, true);
  await image.clearAllImages();
  assert.equal(image.getUploadedImages().length, 0);
  assert.equal(h.counts.fetch, 0);
  assert.equal(h.counts.save, 3);
});

test('retained rollback registry is inert while disabled (Lead entry guard)', async () => {
  const h = await harness({ enabled: false });
  const rollback = await h.importSource('toolkit/phone/messages/message-rollback-manager.js');
  let calls = 0;
  rollback.registerRollbackHandler({ name: 'synthetic', rollback: async () => { calls++; } });
  const off = await rollback.executeRollbackHandlers('fixture', [{ id: 'synthetic' }]);
  assert.equal(off.total, 0);
  assert.equal(calls, 0);
  h.settings.acsusStandalonePhone.phone.enabled = true;
  const on = await rollback.executeRollbackHandlers('fixture', [{ id: 'synthetic' }]);
  assert.equal(on.total, 1);
  assert.equal(calls, 1);
});
