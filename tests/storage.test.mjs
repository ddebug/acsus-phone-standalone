import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
    createPhoneFileStore, PHONE_FILE_NAME, PHONE_FILE_PATH, PHONE_FORMAT,
} from '../standalone/file-store.js';

// Every byte is a synthetic fixture. No browser, real API or user settings IO.
const envelope = (phone, revision = 'fixture-revision') => ({
    format: PHONE_FORMAT, version: 1, revision, writerId: 'fixture-writer', phone,
});
const clone = value => JSON.parse(JSON.stringify(value));
function gate() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
let harnessSequence = 0;
function harness(options = {}) {
    const sequence = ++harnessSequence;
    let ids = 0;
    const files = options.files ?? new Map();
    if (options.initialText !== undefined) files.set(PHONE_FILE_NAME, options.initialText);
    else if (options.initialPhone !== undefined) files.set(PHONE_FILE_NAME, JSON.stringify(envelope(options.initialPhone)));
    const h = {
        files, memory: options.memory ?? {}, requests: [], posts: [], statuses: [],
        before: options.before, afterPost: options.afterPost, maxActivePosts: 0, activePosts: 0,
    };
    h.fetch = async (url, init) => {
        const request = { url, ...init };
        h.requests.push(request);
        const isPost = init.method === 'POST';
        if (isPost) h.maxActivePosts = Math.max(h.maxActivePosts, ++h.activePosts);
        try {
            const override = await h.before?.(request, h);
            if (override !== undefined) return override;
            if (init.method === 'GET') {
                assert.equal(init.cache, 'no-store');
                assert.equal(init.credentials, 'same-origin');
                assert.ok(url.startsWith('/user/files/'));
                const name = decodeURIComponent(url.slice('/user/files/'.length));
                return files.has(name)
                    ? new Response(files.get(name), { status: 200, headers: { 'Content-Type': 'application/json' } })
                    : new Response('not found', { status: 404 });
            }
            assert.equal(url, '/api/files/upload');
            assert.equal(init.credentials, 'same-origin');
            assert.equal(new Headers(init.headers).get('x-csrf-token'), 'synthetic-csrf');
            const upload = JSON.parse(init.body);
            assert.match(upload.name, /^acsus-phone-standalone(?:-before-import-[\w.-]+)?\.json$/);
            const text = Buffer.from(upload.data, 'base64').toString('utf8');
            const posted = { name: upload.name, text, envelope: JSON.parse(text) };
            h.posts.push(posted);
            files.set(upload.name, text);
            return await h.afterPost?.(posted, h) ?? new Response('{}', { status: 200 });
        } finally { if (isPost) h.activePosts--; }
    };
    h.store = createPhoneFileStore({
        fetch: h.fetch,
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'synthetic-csrf' }),
        getPhone: () => h.memory,
        replacePhone: phone => { h.memory = phone; },
        randomId: () => `synthetic-${sequence}-${++ids}`,
        now: () => Date.UTC(2026, 10, 7, 0, 0, 0),
        onStatus: status => { h.statuses.push(status); options.onStatus?.(status); },
        debounceMs: options.debounceMs ?? 0,
        limits: options.limits,
        withLock: options.withLock,
    });
    h.current = () => JSON.parse(files.get(PHONE_FILE_NAME));
    return h;
}

async function rejectsCode(promise, code) {
    await assert.rejects(promise, error => error.code === code);
}

test('404 initializes once without creating a file; plain empty memory never auto-writes', async () => {
    const h = harness();
    assert.equal(h.requests.length, 0);
    const first = h.store.initPhoneStorage();
    assert.strictEqual(h.store.initPhoneStorage(), first);
    await first;
    assert.deepEqual(h.memory, {});
    await h.store.flushPhoneStorage();
    await h.store.saveSettingsDebounced();
    assert.equal(h.requests.length, 1);
    assert.equal(h.posts.length, 0);
    assert.equal(h.store.getStorageStatus().ready, true);
    assert.equal(h.store.getStorageStatus().dirty, false);
});

test('UTF-8 Chinese roundtrip, live data isolation and unique writer identity', async () => {
    const h = harness();
    await h.store.initPhoneStorage();
    h.memory.contacts = [{ id: '合成联系人', name: '测试甲🌸' }];
    h.memory.chats = { '合成联系人': [{ content: '合成消息：你好，世界。' }] };
    await h.store.saveSettingsDebounced();
    assert.deepEqual(h.current().phone, h.memory);
    assert.equal(h.current().writerId, h.store.getStorageStatus().writerId);
    assert.equal(h.store.getStorageStatus().dirty, false);
    assert.equal(h.store.getStorageStatus().saving, false);
    assert.deepEqual(h.requests.map(request => request.method), ['GET', 'GET', 'POST', 'GET']);
    const second = harness({ files: h.files });
    await second.store.initPhoneStorage();
    assert.deepEqual(second.memory, h.memory);
    assert.notEqual(second.store.getStorageStatus().writerId, h.store.getStorageStatus().writerId);
    const backup = h.store.exportPhoneBackup({ includeSecrets: true });
    backup.phone.contacts[0].name = '不会修改内存';
    assert.equal(h.memory.contacts[0].name, '测试甲🌸');
});

for (const [label, fixture, code] of [
    ['401', 401, 'READ_HTTP'], ['500', 500, 'READ_HTTP'],
    ['invalid JSON', '{bad json', 'INVALID_JSON'], ['zero-byte file', '', 'INVALID_JSON'],
    ['wrong version', JSON.stringify({ ...envelope({}), version: 2 }), 'FORMAT'],
    ['wrong format', JSON.stringify({ ...envelope({}), format: 'unrelated' }), 'FORMAT'],
    ['missing revision', JSON.stringify({ format: PHONE_FORMAT, version: 1, phone: {} }), 'FORMAT'],
    ['non-object phone', JSON.stringify(envelope([])), 'FORMAT'],
    ['unsafe nested key', '{"format":"acsus-phone-standalone","version":1,"revision":"x","phone":{"contacts":[{"__proto__":{"polluted":true}}]}}', 'UNSAFE_KEY'],
]) {
    test(`initial ${label} fails closed, retains memory and never uploads`, async () => {
        const h = harness({ memory: { contacts: [{ id: 'synthetic-local' }] }, initialText: typeof fixture === 'string' ? fixture : undefined });
        if (typeof fixture === 'number') h.before = () => new Response('synthetic server failure', { status: fixture });
        const original = h.memory;
        await rejectsCode(h.store.initPhoneStorage(), code);
        await rejectsCode(h.store.initPhoneStorage(), code);
        await rejectsCode(h.store.saveSettingsDebounced(), 'NOT_READY');
        await rejectsCode(h.store.flushPhoneStorage(), 'NOT_READY');
        assert.strictEqual(h.memory, original);
        assert.equal(h.store.getStorageStatus().ready, false);
        assert.equal(h.posts.length, 0);
        assert.equal(h.requests.length, 1);
        assert.equal({}.polluted, undefined);
    });
}

test('initial network failure is not an empty file', async () => {
    const h = harness({ before: () => { throw new Error('synthetic offline'); } });
    await rejectsCode(h.store.initPhoneStorage(), 'READ_FAILED');
    assert.equal(h.store.getStorageStatus().ready, false);
    assert.equal(h.posts.length, 0);
});

test('saves are serialized; edits during POST and queued debounces retain the last change', async () => {
    const entered = gate();
    const release = gate();
    const h = harness({ before: async (request, state) => {
        if (request.method === 'POST' && state.posts.length === 0) {
            entered.resolve();
            await release.promise;
        }
    } });
    await h.store.initPhoneStorage();
    h.memory.contacts = [{ name: 'first synthetic edit' }];
    const first = h.store.flushPhoneStorage();
    await entered.promise;
    h.memory.contacts[0].name = 'last synthetic edit';
    const debounced = h.store.saveSettingsDebounced();
    const last = h.store.flushPhoneStorage();
    release.resolve();
    await Promise.all([first, debounced, last]);
    assert.equal(h.posts.length, 2);
    assert.equal(h.maxActivePosts, 1);
    assert.equal(h.current().phone.contacts[0].name, 'last synthetic edit');
    assert.equal(h.store.getStorageStatus().dirty, false);
});

test('save also detects edits during verified readback without another debounce call', async () => {
    let changed = false;
    const h = harness({ before: (request, state) => {
        if (request.method === 'GET' && state.posts.length === 1 && !changed) {
            changed = true;
            state.memory.contacts.push({ id: 'synthetic-during-readback' });
        }
    } });
    await h.store.initPhoneStorage();
    h.memory.contacts = [];
    await h.store.flushPhoneStorage();
    assert.equal(h.posts.length, 2);
    assert.deepEqual(h.current().phone, h.memory);
});

for (const change of ['revision', 'deleted', 'same-revision-content', 'created-after-404']) {
    test(`preflight detects ${change} conflict and refuses subsequent writes`, async () => {
        const h = harness(change === 'created-after-404' ? {} : { initialPhone: { contacts: [] } });
        await h.store.initPhoneStorage();
        h.memory.contacts = [{ id: 'synthetic-local-edit' }];
        if (change === 'deleted') h.files.delete(PHONE_FILE_NAME);
        else h.files.set(PHONE_FILE_NAME, JSON.stringify(envelope({ contacts: [{ id: 'synthetic-other-session' }] }, change === 'revision' ? 'other-revision' : 'fixture-revision')));
        await rejectsCode(h.store.flushPhoneStorage(), 'CONFLICT');
        await rejectsCode(h.store.saveSettingsDebounced(), 'CONFLICT');
        assert.equal(h.posts.length, 0);
        assert.equal(h.store.getStorageStatus().blocked, true);
        assert.equal(h.store.getStorageStatus().dirty, true);
        assert.equal(h.memory.contacts[0].id, 'synthetic-local-edit');
    });
}

test('preflight HTTP failure does not upload and retains dirty data for an explicit safe retry', async () => {
    const h = harness({ initialPhone: { contacts: [] } });
    await h.store.initPhoneStorage();
    h.memory.contacts.push({ id: 'synthetic-unsaved' });
    h.before = () => new Response('synthetic failure', { status: 500 });
    await rejectsCode(h.store.flushPhoneStorage(), 'READ_HTTP');
    assert.equal(h.posts.length, 0);
    assert.equal(h.store.getStorageStatus().dirty, true);
    assert.equal(h.store.getStorageStatus().blocked, false);
    h.before = undefined;
    await h.store.flushPhoneStorage();
    assert.equal(h.posts.length, 1);
});

for (const failure of ['post-http', 'post-network', 'readback-http', 'readback-missing', 'readback-revision', 'readback-phone', 'readback-writer']) {
    test(`${failure} latches ambiguous state; no automatic or explicit overwrite retry`, async () => {
        const h = harness({ initialPhone: { contacts: [] } });
        await h.store.initPhoneStorage();
        h.memory.contacts.push({ id: 'synthetic-unsaved' });
        if (failure === 'post-network') h.before = request => { if (request.method === 'POST') throw new Error('synthetic dropped response'); };
        if (failure === 'readback-http') h.before = (request, state) => {
            if (request.method === 'GET' && state.posts.length) return new Response('synthetic readback error', { status: 500 });
        };
        h.afterPost = (posted, state) => {
            if (failure === 'post-http') return new Response('synthetic uncertain upload', { status: 500 });
            if (failure === 'readback-missing') state.files.delete(posted.name);
            if (failure === 'readback-revision') state.files.set(posted.name, JSON.stringify({ ...posted.envelope, revision: 'synthetic-overwritten' }));
            if (failure === 'readback-phone') state.files.set(posted.name, JSON.stringify({ ...posted.envelope, phone: { contacts: [{ id: 'synthetic-overwritten' }] } }));
            if (failure === 'readback-writer') state.files.set(posted.name, JSON.stringify({ ...posted.envelope, writerId: 'another-synthetic-writer' }));
        };
        await rejectsCode(h.store.flushPhoneStorage(), 'AMBIGUOUS');
        const attempts = h.requests.filter(request => request.method === 'POST').length;
        await rejectsCode(h.store.flushPhoneStorage(), 'AMBIGUOUS');
        await rejectsCode(h.store.saveSettingsDebounced(), 'AMBIGUOUS');
        await rejectsCode(h.store.importPhoneBackup({ contacts: [] }), 'AMBIGUOUS');
        assert.equal(h.requests.filter(request => request.method === 'POST').length, attempts);
        assert.equal(h.store.getStorageStatus().blocked, true);
        assert.equal(h.store.getStorageStatus().requiresReload, true);
        assert.equal(h.store.getStorageStatus().dirty, true);
        assert.equal(h.store.exportPhoneBackup().phone.contacts[0].id, 'synthetic-unsaved');
    });
}

test('fire-and-forget debounce rejection is observed but the same promise remains awaitably rejected', async t => {
    const errors = [];
    const status = gate();
    const handler = reason => errors.push(reason);
    process.on('unhandledRejection', handler);
    t.after(() => process.off('unhandledRejection', handler));
    const h = harness({
        afterPost: () => new Response('synthetic failure', { status: 500 }),
        onStatus: current => { if (current.blocked) status.resolve(); },
    });
    await h.store.initPhoneStorage();
    h.memory.chats = [];
    const promise = h.store.saveSettingsDebounced();
    // Deliberately do not attach a consumer handler until the timer has failed.
    await status.promise;
    await nextTurn();
    await rejectsCode(promise, 'AMBIGUOUS');
    assert.deepEqual(errors, []);
});

test('default export removes credential fields recursively without deleting synthetic chats', async () => {
    const phone = {
        contacts: [], chats: [{ content: 'synthetic literal apiKey token password in a message', tokenCount: 17 }],
        config: {
            apiKey: 'synthetic-secret', API_KEY: 'synthetic-secret', key: 'synthetic-secret', token: 'synthetic-secret',
            password: 'synthetic-secret', reverseProxyPassword: 'synthetic-secret', Authorization: 'synthetic-secret',
            clientSecret: 'synthetic-secret', access_token: 'synthetic-secret', refreshToken: 'synthetic-secret',
            openRouterKey: 'synthetic-secret', customIncludeHeaders: 'synthetic-secret',
            headers: { 'X-Synthetic': 'synthetic-secret' }, nested: [{ 'x-api-key': 'synthetic-secret', model: 'synthetic-model' }],
            maxTokens: 2048, temperature: 0.8,
        },
    };
    const h = harness({ initialPhone: phone });
    await h.store.initPhoneStorage();
    const safe = h.store.exportPhoneBackup();
    assert.deepEqual(safe.phone.chats, phone.chats);
    assert.deepEqual(safe.phone.config, { nested: [{ model: 'synthetic-model' }], maxTokens: 2048, temperature: 0.8 });
    assert.deepEqual(h.store.exportPhoneBackup({ includeSecrets: true }).phone, phone);
    assert.deepEqual(h.store.exportPhoneBackup({ includeSecrets: 'false' }).phone, safe.phone);
    assert.deepEqual(h.memory, phone);
    assert.equal(h.posts.length, 0);
});

const importPhone = { contacts: [{ id: 'synthetic-imported' }], chats: [{ content: '合成导入内容' }], config: { api_key: 'synthetic-do-not-migrate', model: 'synthetic-model' } };
for (const [label, input] of [
    ['envelope', envelope(importPhone, 'untrusted-imported-revision')],
    ['JSON text', JSON.stringify(envelope(importPhone, 'untrusted-imported-revision'))],
    ['legacy full settings', { extension_settings: { acsusPawsPuffs: { phone: importPhone } }, unrelated: 'synthetic' }],
    ['standalone full settings', { extension_settings: { acsusStandalonePhone: { phone: importPhone } } }],
    ['legacy namespace', { acsusPawsPuffs: { phone: importPhone } }],
    ['standalone namespace', { acsusStandalonePhone: { phone: importPhone } }],
    ['plain phone', importPhone],
]) {
    test(`import ${label} backs up exact file, verifies both writes and drops credentials`, async () => {
        const initialText = `\n${JSON.stringify(envelope({ contacts: [{ id: 'synthetic-before' }] }), null, 2)}\n`;
        const h = harness({ initialText });
        await h.store.initPhoneStorage();
        const before = h.memory;
        const result = await h.store.importPhoneBackup(clone(input));
        assert.equal(h.posts.length, 2);
        assert.match(h.posts[0].name, /^acsus-phone-standalone-before-import-/);
        assert.equal(h.files.get(h.posts[0].name), initialText);
        assert.equal(result.backupPath, `/user/files/${h.posts[0].name}`);
        assert.notStrictEqual(h.memory, before);
        assert.deepEqual(h.memory, { contacts: importPhone.contacts, chats: importPhone.chats, config: { model: 'synthetic-model' } });
        assert.deepEqual(h.current().phone, h.memory);
        assert.notEqual(h.current().revision, 'untrusted-imported-revision');
        assert.equal(h.current().writerId, h.store.getStorageStatus().writerId);
        assert.equal(h.store.getStorageStatus().dirty, false);
        assert.equal(h.store.getStorageStatus().importing, false);
        const methods = h.requests.map(request => request.method);
        assert.deepEqual(methods, ['GET', 'GET', 'POST', 'GET', 'GET', 'POST', 'GET']);
    });
}

test('legacy top-level favorites migrate only from selected file when candidate has no items', async () => {
    for (const favorites of [undefined, { items: [] }, { items: [{ id: 'synthetic-new' }] }]) {
        const candidate = { contacts: [] };
        if (favorites !== undefined) candidate.favorites = favorites;
        const legacyFavorites = { items: [{ id: 'synthetic-old-favorite', content: '合成收藏' }] };
        const h = harness();
        await h.store.initPhoneStorage();
        await h.store.importPhoneBackup({ extension_settings: { acsusPawsPuffs: { phone: candidate }, phone: { favorites: legacyFavorites } } });
        assert.deepEqual(h.memory.favorites, favorites?.items.length ? favorites : legacyFavorites);
    }
});

test('import into 404 first writes and verifies a recoverable empty snapshot', async () => {
    const h = harness();
    await h.store.initPhoneStorage();
    await h.store.importPhoneBackup({ contacts: [] });
    assert.equal(h.posts.length, 2);
    assert.deepEqual(h.posts[0].envelope.phone, {});
    assert.equal(h.posts[0].envelope.format, PHONE_FORMAT);
    assert.deepEqual(h.current().phone, { contacts: [] });
});

for (const failure of ['backup-post', 'backup-readback', 'candidate-post', 'candidate-readback']) {
    test(`import ${failure} failure preserves memory snapshot, backup and blocks uncertain retry`, async () => {
        const initialText = JSON.stringify(envelope({ contacts: [{ id: 'synthetic-original' }] }));
        const h = harness({ initialText });
        await h.store.initPhoneStorage();
        const before = h.memory;
        h.afterPost = (posted, state) => {
            const backup = posted.name !== PHONE_FILE_NAME;
            if (failure === 'backup-post' && backup || failure === 'candidate-post' && !backup) return new Response('synthetic failure', { status: 500 });
            if (failure === 'backup-readback' && backup || failure === 'candidate-readback' && !backup) state.files.set(posted.name, JSON.stringify(envelope({ chats: ['synthetic-mismatch'] }, 'wrong-readback')));
        };
        await rejectsCode(h.store.importPhoneBackup({ contacts: [{ id: 'synthetic-candidate' }] }), 'AMBIGUOUS');
        assert.strictEqual(h.memory, before);
        assert.equal(h.memory.contacts[0].id, 'synthetic-original');
        assert.equal(h.store.getStorageStatus().dirty, true);
        assert.equal(h.store.getStorageStatus().blocked, true);
        if (failure.startsWith('backup')) {
            assert.equal(h.posts.length, 1);
            assert.equal(h.files.get(PHONE_FILE_NAME), initialText);
        } else {
            assert.equal(h.files.get(h.posts[0].name), initialText);
        }
        const posts = h.posts.length;
        await rejectsCode(h.store.flushPhoneStorage(), 'AMBIGUOUS');
        assert.equal(h.posts.length, posts);
    });
}

test('import drains pending debounced save before taking backup', async () => {
    const h = harness({ initialPhone: { contacts: [] }, debounceMs: 200 });
    await h.store.initPhoneStorage();
    h.memory.contacts.push({ id: 'synthetic-pending-save' });
    const pending = h.store.saveSettingsDebounced();
    await h.store.importPhoneBackup({ contacts: [{ id: 'synthetic-imported' }] });
    await pending;
    assert.equal(h.posts.length, 3);
    assert.equal(h.posts[0].name, PHONE_FILE_NAME);
    assert.equal(h.posts[1].text, h.posts[0].text);
    assert.deepEqual(h.posts[1].envelope.phone, { contacts: [{ id: 'synthetic-pending-save' }] });
    assert.equal(h.memory.contacts[0].id, 'synthetic-imported');
});

test('import freezes saves and preserves local edits made during the backup transaction', async () => {
    const entered = gate();
    const release = gate();
    const h = harness({ initialPhone: { contacts: [] }, before: async request => {
        if (request.method === 'POST') { entered.resolve(); await release.promise; }
    } });
    await h.store.initPhoneStorage();
    const task = h.store.importPhoneBackup({ contacts: [{ id: 'synthetic-imported' }] });
    await entered.promise;
    h.memory.contacts.push({ id: 'synthetic-new-local' });
    await rejectsCode(h.store.saveSettingsDebounced(), 'IMPORT_BUSY');
    await rejectsCode(h.store.flushPhoneStorage(), 'IMPORT_BUSY');
    release.resolve();
    await rejectsCode(task, 'LOCAL_CONFLICT');
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.current().phone, { contacts: [] });
    assert.deepEqual(h.memory.contacts, [{ id: 'synthetic-new-local' }]);
    assert.equal(h.store.getStorageStatus().dirty, true);
});

test('edits during candidate upload remain in memory and latch a local conflict after verified commit', async () => {
    const entered = gate();
    const release = gate();
    const h = harness({ initialPhone: { contacts: [] }, before: async request => {
        if (request.method === 'POST' && JSON.parse(request.body).name === PHONE_FILE_NAME) { entered.resolve(); await release.promise; }
    } });
    await h.store.initPhoneStorage();
    const task = h.store.importPhoneBackup({ contacts: [{ id: 'synthetic-imported' }] });
    await entered.promise;
    h.memory.contacts.push({ id: 'synthetic-new-local' });
    await rejectsCode(h.store.saveSettingsDebounced(), 'IMPORT_BUSY');
    release.resolve();
    await rejectsCode(task, 'LOCAL_CONFLICT');
    assert.equal(h.current().phone.contacts[0].id, 'synthetic-imported');
    assert.equal(h.memory.contacts[0].id, 'synthetic-new-local');
    assert.equal(h.store.getStorageStatus().blocked, true);
    assert.equal(h.store.getStorageStatus().dirty, true);
    const count = h.posts.length;
    await rejectsCode(h.store.flushPhoneStorage(), 'LOCAL_CONFLICT');
    assert.equal(h.posts.length, count);
});

test('another writer during backup is detected by the second preflight', async () => {
    const h = harness({ initialPhone: { contacts: [] }, afterPost: (posted, state) => {
        if (posted.name !== PHONE_FILE_NAME) state.files.set(PHONE_FILE_NAME, JSON.stringify(envelope({ contacts: [{ id: 'synthetic-other-writer' }] }, 'new-remote')));
    } });
    await h.store.initPhoneStorage();
    await rejectsCode(h.store.importPhoneBackup({ contacts: [] }), 'CONFLICT');
    assert.equal(h.posts.length, 1);
    assert.equal(h.current().phone.contacts[0].id, 'synthetic-other-writer');
});

for (const key of ['__proto__', 'prototype', 'constructor']) {
    test(`import rejects nested ${key} without prototype pollution or uploads`, async () => {
        const h = harness();
        await h.store.initPhoneStorage();
        await rejectsCode(h.store.importPhoneBackup(`{"contacts":[{"${key}":{"syntheticPollution":true}}]}`), 'UNSAFE_KEY');
        assert.equal({}.syntheticPollution, undefined);
        assert.equal(h.posts.length, 0);
    });
}

for (const value of [{}, { random: true }, [], null, 123, { contacts: 'not-a-collection' }, { acsusPawsPuffs: { phone: null } }, { ...envelope({ contacts: [] }), version: 99 }]) {
    test(`import refuses unrecognized or unsupported shape ${JSON.stringify(value)}`, async () => {
        const h = harness();
        await h.store.initPhoneStorage();
        await assert.rejects(h.store.importPhoneBackup(value));
        assert.equal(h.posts.length, 0);
        assert.deepEqual(h.memory, {});
    });
}

test('strict JSON validation bounds depth, nodes, strings and UTF-8 bytes before any upload', async () => {
    const cases = [
        [{ contacts: [{ child: { child: { child: 'deep' } } }] }, { maxDepth: 3 }],
        [{ contacts: [1, 2, 3, 4, 5, 6, 7] }, { maxNodes: 5 }],
        [{ contacts: [], content: '合成中文字符' }, { maxStringBytes: 8 }],
        [JSON.stringify({ contacts: [], content: 'a'.repeat(200) }), { maxBytes: 100 }],
    ];
    for (const [value, limits] of cases) {
        const h = harness({ limits });
        await h.store.initPhoneStorage();
        await rejectsCode(h.store.importPhoneBackup(value), 'LIMIT');
        assert.equal(h.posts.length, 0);
    }
    const oversized = harness({ initialText: ' '.repeat(120), limits: { maxBytes: 100 } });
    await rejectsCode(oversized.store.initPhoneStorage(), 'LIMIT');
    assert.equal(oversized.posts.length, 0);
});

test('cycles, accessors, custom prototypes and non-JSON values cannot execute or upload', async () => {
    let called = false;
    const cyclic = { contacts: [] };
    cyclic.self = cyclic;
    const accessor = { contacts: [] };
    Object.defineProperty(accessor, 'danger', { enumerable: true, get() { called = true; return 'not executed'; } });
    const values = [cyclic, accessor, { contacts: [], date: new Date() }, Object.assign(Object.create({ inherited: true }), { contacts: [] }), { contacts: [], invalid: undefined }, { contacts: [], invalid: NaN }, { contacts: [], invalid() {} }, { contacts: new Array(2) }];
    const h = harness();
    await h.store.initPhoneStorage();
    for (const value of values) await rejectsCode(h.store.importPhoneBackup(value), 'INVALID_JSON');
    assert.equal(called, false);
    assert.equal(h.posts.length, 0);
});

test('a queued save after an uncertain upload cannot silently retry over unknown remote data', async () => {
    const entered = gate();
    const release = gate();
    const h = harness({
        before: async request => { if (request.method === 'POST') { entered.resolve(); await release.promise; } },
        afterPost: () => new Response('synthetic uncertain response', { status: 500 }),
    });
    await h.store.initPhoneStorage();
    h.memory.contacts = [{ id: 'synthetic-first' }];
    const first = h.store.flushPhoneStorage();
    await entered.promise;
    h.memory.contacts.push({ id: 'synthetic-later' });
    const pending = h.store.saveSettingsDebounced();
    const queued = h.store.flushPhoneStorage();
    release.resolve();
    await rejectsCode(first, 'AMBIGUOUS');
    await rejectsCode(pending, 'AMBIGUOUS');
    await rejectsCode(queued, 'AMBIGUOUS');
    assert.equal(h.posts.length, 1);
    assert.equal(h.memory.contacts.length, 2);
    assert.equal(h.store.getStorageStatus().dirty, true);
});

test('invalid live edits during import are reported and retained without stale rollback', async () => {
    const entered = gate();
    const release = gate();
    const h = harness({ initialPhone: { contacts: [] }, before: async request => {
        if (request.method === 'POST') { entered.resolve(); await release.promise; }
    } });
    await h.store.initPhoneStorage();
    const task = h.store.importPhoneBackup({ contacts: [] });
    await entered.promise;
    h.memory.invalid = undefined;
    release.resolve();
    await rejectsCode(task, 'INVALID_JSON');
    assert.equal(Object.hasOwn(h.memory, 'invalid'), true);
    assert.equal(h.store.getStorageStatus().dirty, true);
    assert.equal(h.store.getStorageStatus().error.code, 'INVALID_JSON');
    assert.equal(h.store.getStorageStatus().importing, false);
    assert.equal(h.posts.length, 1);
});

test('status observer failure cannot make confirmed persistence fail; same-origin lock wraps writes', async () => {
    let locks = 0;
    const h = harness({
        onStatus: () => { throw new Error('synthetic observer exception'); },
        withLock: async operation => { locks++; return operation(); },
    });
    await h.store.initPhoneStorage();
    h.memory.contacts = [];
    await h.store.flushPhoneStorage();
    assert.equal(locks, 1);
    assert.equal(h.store.getStorageStatus().dirty, false);
    assert.equal(h.store.getStorageStatus().error, null);
    assert.equal(h.store.getStorageStatus().path, PHONE_FILE_PATH);
    assert.ok(h.statuses.every(status => !Object.hasOwn(status, 'phone')));
});
