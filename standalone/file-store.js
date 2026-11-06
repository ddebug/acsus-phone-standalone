/**
 * Isolated user-file persistence. All host access is injected; importing this
 * module performs no IO. The files API has no atomic CAS: a preflight revision,
 * writer ID and verified readback detect many races, but cannot make concurrent
 * cross-device writers safe. Use one active device; a blocked store needs reload.
 */
export const PHONE_FILE_NAME = 'acsus-phone-standalone.json';
export const PHONE_FILE_PATH = `/user/files/${PHONE_FILE_NAME}`;
export const PHONE_FORMAT = 'acsus-phone-standalone';
export const PHONE_VERSION = 1;

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PHONE_COLLECTIONS = new Set([
    'contacts', 'chats', 'messages', 'favorites', 'plans', 'emojiPacks',
    'userProfile', 'apiConfigs', 'apiSettings', 'wallet', 'membership',
]);
const DEFAULT_LIMITS = Object.freeze({
    maxBytes: 20 * 1024 * 1024,
    maxDepth: 100,
    maxNodes: 200_000,
    maxStringBytes: 4 * 1024 * 1024,
});
const encoder = new TextEncoder();

export class PhoneStorageError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PhoneStorageError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new PhoneStorageError(code, message);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function observed(promise) {
    // Keep the original rejection awaitable, while legacy fire-and-forget calls
    // do not produce unhandled rejections. Do not return the catch's promise.
    void promise.catch(() => {});
    return promise;
}

function deferred() {
    let resolve;
    let reject;
    const promise = observed(new Promise((yes, no) => { resolve = yes; reject = no; }));
    return { promise, resolve, reject };
}

/** Copy only bounded JSON graphs, without invoking getters or inherited fields. */
function copyJson(value, limits) {
    let nodes = 0;
    const ancestors = new WeakSet();
    function visit(item, depth) {
        if (++nodes > limits.maxNodes || depth > limits.maxDepth) {
            fail('LIMIT', 'Phone data exceeds the JSON depth/node limit.');
        }
        if (item === null || typeof item === 'boolean') return item;
        if (typeof item === 'string') {
            if (encoder.encode(item).byteLength > limits.maxStringBytes) {
                fail('LIMIT', 'A phone data string exceeds the size limit.');
            }
            return item;
        }
        if (typeof item === 'number' && Number.isFinite(item)) return item;
        if (typeof item !== 'object') fail('INVALID_JSON', 'Phone data must contain only JSON values.');
        const prototype = Object.getPrototypeOf(item);
        if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
            fail('INVALID_JSON', 'Phone data must contain only plain JSON objects.');
        }
        if (ancestors.has(item)) fail('INVALID_JSON', 'Cyclic phone data cannot be saved.');
        if (Object.getOwnPropertySymbols(item).length) fail('INVALID_JSON', 'Symbol properties are not JSON data.');
        const array = Array.isArray(item);
        if (array && item.length > limits.maxNodes) fail('LIMIT', 'Phone array exceeds the node limit.');
        const keys = Object.getOwnPropertyNames(item).filter(key => !(array && key === 'length'));
        if (keys.length > limits.maxNodes) fail('LIMIT', 'Phone object exceeds the node limit.');
        for (const key of keys) {
            if (FORBIDDEN_KEYS.has(key)) fail('UNSAFE_KEY', 'Unsafe prototype-related field in phone data.');
            if (encoder.encode(key).byteLength > limits.maxStringBytes) fail('LIMIT', 'A JSON key exceeds the size limit.');
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            if (!descriptor.enumerable || descriptor.get || descriptor.set) {
                fail('INVALID_JSON', 'Hidden/accessor properties are not supported JSON data.');
            }
            if (array && !/^(0|[1-9]\d*)$/.test(key)) fail('INVALID_JSON', 'Named array properties are not JSON data.');
        }
        ancestors.add(item);
        const result = array ? [] : {};
        if (array) {
            for (let index = 0; index < item.length; index++) {
                if (!Object.hasOwn(item, index)) fail('INVALID_JSON', 'Sparse arrays are not supported JSON data.');
                result.push(visit(item[index], depth + 1));
            }
        } else {
            // Stable ordering makes comparisons independent of object key order.
            for (const key of keys.sort()) result[key] = visit(item[key], depth + 1);
        }
        ancestors.delete(item);
        return result;
    }
    const result = visit(value, 0);
    const text = JSON.stringify(result);
    if (encoder.encode(text).byteLength > limits.maxBytes) fail('LIMIT', 'Phone data exceeds the file size limit.');
    return { value: result, text };
}

function parseJson(text, limits) {
    if (typeof text !== 'string') fail('INVALID_JSON', 'Expected JSON text.');
    if (encoder.encode(text).byteLength > limits.maxBytes) fail('LIMIT', 'Phone data exceeds the file size limit.');
    let value;
    try { value = JSON.parse(text); }
    catch { fail('INVALID_JSON', 'The phone file is not valid JSON; it was not replaced.'); }
    return copyJson(value, limits);
}

function validateEnvelope(value) {
    if (!isRecord(value) || value.format !== PHONE_FORMAT || value.version !== PHONE_VERSION) {
        fail('FORMAT', 'Unsupported phone file format/version; it was not replaced.');
    }
    if (typeof value.revision !== 'string' || !value.revision.trim() || value.revision.length > 256) {
        fail('FORMAT', 'The phone file has no valid revision.');
    }
    if (!isRecord(value.phone)) fail('FORMAT', 'The phone file must contain a phone object.');
    if (value.writerId !== undefined && (typeof value.writerId !== 'string' || value.writerId.length > 256)) {
        fail('FORMAT', 'The phone file has an invalid writer identifier.');
    }
    return value;
}

function decodeBackup(input, limits) {
    const { value } = typeof input === 'string' ? parseJson(input, limits) : copyJson(input, limits);
    if (!isRecord(value)) fail('IMPORT_FORMAT', 'Select a phone backup, not an arbitrary JSON value.');
    let phone;
    if (Object.hasOwn(value, 'format')) {
        phone = validateEnvelope(value).phone;
    } else if (isRecord(value.extension_settings?.acsusStandalonePhone)) {
        phone = value.extension_settings.acsusStandalonePhone.phone;
    } else if (isRecord(value.extension_settings?.acsusPawsPuffs)) {
        phone = value.extension_settings.acsusPawsPuffs.phone;
    } else if (isRecord(value.acsusStandalonePhone)) {
        phone = value.acsusStandalonePhone.phone;
    } else if (isRecord(value.acsusPawsPuffs)) {
        phone = value.acsusPawsPuffs.phone;
    } else if (Object.entries(value).some(([key, entry]) => PHONE_COLLECTIONS.has(key) && entry !== null && typeof entry === 'object')) {
        phone = value;
    } else {
        fail('IMPORT_FORMAT', 'JSON does not contain a recognized phone data structure.');
    }
    if (!isRecord(phone)) fail('IMPORT_FORMAT', 'The imported phone must be a JSON object.');
    // The old plugin stored favorites outside its own namespace. Consult only
    // the explicitly selected import file, never the real host settings object.
    const legacyFavorites = value.extension_settings?.phone?.favorites;
    const favorites = phone.favorites;
    const hasFavorites = Array.isArray(favorites) ? favorites.length > 0
        : isRecord(favorites) && (Array.isArray(favorites.items) ? favorites.items.length > 0 : Object.keys(favorites).length > 0);
    if (!hasFavorites && legacyFavorites !== null && typeof legacyFavorites === 'object') {
        phone = { ...phone, favorites: legacyFavorites };
    }
    // Imports never migrate credentials, even when the selected export opted in.
    return copyJson(withoutSecrets(phone), limits);
}

function secretField(key) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    // Match credential fields, not message bodies or token-count parameters.
    return /(?:apikey|password|authorization|secret|accesstoken|refreshtoken|authtoken|bearertoken)/.test(normalized)
        || /token$/.test(normalized)
        || /^(?:key|token|cookie|cookies|credential|credentials|headers|requestheaders|extraheaders|authheaders|customincludeheaders|customheaders|privatekey|openrouterkey|clientkey)$/.test(normalized)
        || /^(?:openai|anthropic|claude|gemini|google|azure|vertex|mistral|cohere|deepseek|custom|proxy|reverseproxy|subscription|api)key$/.test(normalized);
}

function withoutSecrets(value) {
    if (Array.isArray(value)) return value.map(withoutSecrets);
    if (!isRecord(value)) return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (!secretField(key)) result[key] = withoutSecrets(item);
    }
    return result;
}

function utf8Base64(text) {
    const bytes = encoder.encode(text);
    const parts = [];
    for (let index = 0; index < bytes.length; index += 0x8000) {
        parts.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
    }
    return btoa(parts.join(''));
}

/**
 * Create one isolated writer. Required dependencies never reference host settings.
 * getPhone/replacePhone own the live phone object; fetch/getRequestHeaders are IO.
 * randomId must return a unique random URL-safe ID, including across reloads.
 * withLock may wrap transactions with navigator.locks for same-origin tabs only.
 */
export function createPhoneFileStore({
    fetch: fetchFile,
    getRequestHeaders,
    getPhone,
    replacePhone,
    randomId,
    now = () => Date.now(),
    onStatus = () => {},
    withLock = operation => operation(),
    debounceMs = 200,
    limits: customLimits = {},
}) {
    for (const dependency of [fetchFile, getRequestHeaders, getPhone, replacePhone, randomId, now, onStatus, withLock]) {
        if (typeof dependency !== 'function') throw new TypeError('Phone store dependencies must be functions.');
    }
    const limits = { ...DEFAULT_LIMITS, ...customLimits };
    for (const value of Object.values(limits)) {
        if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('JSON limits must be positive integers.');
    }
    if (!Number.isFinite(debounceMs) || debounceMs < 0 || debounceMs > 300) {
        throw new TypeError('Phone storage debounce must be between 0 and 300ms.');
    }
    const id = () => {
        const value = randomId();
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
            fail('REVISION', 'The revision generator did not return a valid random identifier.');
        }
        return value;
    };
    const writerId = id();
    let ready = false;
    let dirty = false;
    let saving = false;
    let importing = false;
    let error = null;
    let blocked = false;
    let knownRevision = null;
    let committedText = '{}';
    let mutations = 0;
    let initPromise;
    let timer;
    let pending;
    let tail = Promise.resolve();

    function getStorageStatus() {
        return {
            ready, dirty, saving, importing, blocked, requiresReload: blocked,
            error: error ? { code: error.code || 'STORAGE', message: error.message } : null,
            path: PHONE_FILE_PATH, revision: knownRevision, writerId,
        };
    }
    function emit() {
        // A UI listener cannot turn a completed write into a storage failure.
        try { onStatus(getStorageStatus()); } catch { /* Observer failures do not change persistence. */ }
    }
    function report(reason, { latch = false, keepDirty = dirty } = {}) {
        error = reason instanceof PhoneStorageError ? reason : new PhoneStorageError('STORAGE', 'Phone storage operation failed.');
        blocked ||= latch;
        dirty = keepDirty;
        emit();
        return error;
    }
    function requireReady() {
        if (!ready) fail('NOT_READY', 'Phone storage is not initialized; no file was written.');
        if (blocked) fail(error?.code || 'BLOCKED', 'Phone storage is blocked. Export unsaved data and reload before writing.');
    }
    function snapshot() {
        const result = copyJson(getPhone(), limits);
        if (!isRecord(result.value)) fail('FORMAT', 'Phone memory must be a JSON object.');
        return result;
    }
    function envelope(phone) {
        return { format: PHONE_FORMAT, version: PHONE_VERSION, revision: id(), writerId, phone };
    }
    function queue(operation) {
        const task = observed(tail.then(operation));
        tail = task.catch(() => {});
        return task;
    }
    async function readFile(name = PHONE_FILE_NAME) {
        let response;
        try {
            response = await fetchFile(`/user/files/${encodeURIComponent(name)}`, {
                method: 'GET', cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' },
            });
        } catch { fail('READ_FAILED', 'Could not read the phone file; no replacement was attempted.'); }
        if (response.status === 404) return null;
        if (!response.ok) fail('READ_HTTP', `Phone file read failed (HTTP ${response.status}).`);
        const length = response.headers?.get?.('content-length');
        if (length !== null && length !== undefined && Number(length) > limits.maxBytes) fail('LIMIT', 'Phone file exceeds the size limit.');
        let text;
        try {
            if (response.body?.getReader) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8', { fatal: true });
                const chunks = [];
                let bytes = 0;
                try {
                    while (true) {
                        const item = await reader.read();
                        if (item.done) break;
                        bytes += item.value.byteLength;
                        if (bytes > limits.maxBytes) {
                            await reader.cancel();
                            fail('LIMIT', 'Phone file exceeds the size limit.');
                        }
                        chunks.push(decoder.decode(item.value, { stream: true }));
                    }
                    chunks.push(decoder.decode());
                    text = chunks.join('');
                } finally { reader.releaseLock(); }
            } else {
                text = await response.text();
            }
        } catch (reason) {
            if (reason instanceof PhoneStorageError) throw reason;
            fail('READ_FAILED', 'Could not decode the phone file.');
        }
        const parsed = parseJson(text, limits);
        return { envelope: validateEnvelope(parsed.value), text, phoneText: JSON.stringify(parsed.value.phone) };
    }
    function assertRevision(remote) {
        if (knownRevision === null ? remote !== null : remote === null) {
            fail('CONFLICT', 'The phone file was created/deleted by another writer. Reload before saving.');
        }
        if (remote && (remote.envelope.revision !== knownRevision || remote.phoneText !== committedText)) {
            fail('CONFLICT', 'The phone file changed in another session. Export unsaved data and reload.');
        }
    }
    async function uploadVerified(name, text, expected) {
        // Once POST starts, transport/HTTP/readback failure is ambiguous. Never
        // automatically retry, even if the server might have accepted the data.
        try {
            const headers = new Headers(await getRequestHeaders());
            headers.set('Content-Type', 'application/json');
            const body = JSON.stringify({ name, data: utf8Base64(text) });
            const response = await fetchFile('/api/files/upload', {
                method: 'POST', credentials: 'same-origin', headers, body,
            });
            if (!response.ok) fail('AMBIGUOUS', `Phone upload was not confirmed (HTTP ${response.status}).`);
            const readback = await readFile(name);
            const matches = readback !== null && (expected
                ? readback.envelope.revision === expected.revision
                    && readback.envelope.writerId === writerId
                    && readback.phoneText === JSON.stringify(expected.phone)
                : readback.text === text);
            if (!matches) fail('AMBIGUOUS', 'Phone upload readback did not match; further writes are blocked.');
            return readback;
        } catch (reason) {
            throw report(new PhoneStorageError('AMBIGUOUS', reason instanceof PhoneStorageError ? reason.message : 'Phone upload outcome is uncertain; further writes are blocked.'), { latch: true, keepDirty: true });
        }
    }
    function initPhoneStorage() {
        if (initPromise) return initPromise;
        initPromise = observed((async () => {
            try {
                const remote = await readFile();
                // A true 404 is an empty baseline, not a request to create a file.
                const phone = remote ? remote.envelope.phone : {};
                replacePhone(phone);
                knownRevision = remote?.envelope.revision ?? null;
                committedText = remote?.phoneText ?? '{}';
                ready = true;
                dirty = false;
                error = null;
                emit();
                return getPhone();
            } catch (reason) {
                ready = false;
                throw report(reason);
            }
        })());
        return initPromise;
    }
    async function runSave() {
        try {
            requireReady();
            let current = snapshot();
            if (current.text === committedText) {
                dirty = false;
                emit();
                return;
            }
            saving = true;
            dirty = true;
            emit();
            while (current.text !== committedText) {
                await withLock(async () => {
                    const remote = await readFile();
                    assertRevision(remote);
                    const next = envelope(current.value);
                    const text = copyJson(next, limits).text;
                    await uploadVerified(PHONE_FILE_NAME, text, next);
                    knownRevision = next.revision;
                    committedText = current.text;
                });
                // Read the live object again, not only the debounce generation:
                // edits during either POST or readback must persist as well.
                current = snapshot();
                dirty = current.text !== committedText;
                emit();
            }
            error = null;
        } catch (reason) {
            throw report(reason, { latch: blocked || reason?.code === 'CONFLICT', keepDirty: true });
        } finally {
            saving = false;
            emit();
        }
    }
    function scheduleFlush() {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        const waiting = pending;
        pending = undefined;
        const task = queue(runSave);
        if (waiting) void task.then(waiting.resolve, waiting.reject);
        return task;
    }
    function saveSettingsDebounced() {
        mutations++;
        dirty = true;
        emit();
        try {
            requireReady();
            if (importing) fail('IMPORT_BUSY', 'Phone import is in progress; saves are frozen.');
        } catch (reason) {
            return observed(Promise.reject(report(reason)));
        }
        pending ??= deferred();
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => { scheduleFlush(); }, debounceMs);
        return pending.promise;
    }
    function flushPhoneStorage() {
        if (importing) return observed(Promise.reject(new PhoneStorageError('IMPORT_BUSY', 'Phone import is in progress; saves are frozen.')));
        return scheduleFlush();
    }
    function exportPhoneBackup({ includeSecrets = false } = {}) {
        if (!ready) fail('NOT_READY', 'Initialize phone storage before exporting a backup.');
        const phone = snapshot().value;
        return {
            format: PHONE_FORMAT, version: PHONE_VERSION,
            revision: knownRevision ?? id(), writerId,
            phone: includeSecrets === true ? phone : withoutSecrets(phone),
        };
    }
    function importPhoneBackup(input) {
        let candidate;
        let atRequest;
        let requestMutation;
        try {
            requireReady();
            if (importing) fail('IMPORT_BUSY', 'Another phone import is already in progress.');
            candidate = decodeBackup(input, limits);
            atRequest = snapshot();
            requestMutation = mutations;
        } catch (reason) {
            return observed(Promise.reject(report(reason)));
        }
        importing = true;
        emit();
        const prior = scheduleFlush();
        const task = queue(async () => {
            try {
                await prior;
                requireReady();
                saving = true;
                emit();
                const unchanged = () => {
                    if (snapshot().text !== atRequest.text || mutations !== requestMutation) {
                        fail('LOCAL_CONFLICT', 'Phone memory changed during import; local edits were preserved.');
                    }
                };
                unchanged();
                return await withLock(async () => {
                    const remote = await readFile();
                    assertRevision(remote);
                    // A 404 still gets a recoverable empty snapshot before import.
                    const backupText = remote?.text ?? copyJson(envelope(atRequest.value), limits).text;
                    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
                    const backupName = `acsus-phone-standalone-before-import-${stamp}-${id()}.json`;
                    await uploadVerified(backupName, backupText, null);
                    // The backup roundtrip is not a lock against other devices.
                    assertRevision(await readFile());
                    unchanged();
                    // Never trust imported revision/writer IDs as our next version.
                    const next = envelope(candidate.value);
                    await uploadVerified(PHONE_FILE_NAME, copyJson(next, limits).text, next);
                    knownRevision = next.revision;
                    committedText = candidate.text;
                    try { unchanged(); }
                    catch (reason) { throw report(reason, { latch: true, keepDirty: true }); }
                    try { replacePhone(copyJson(candidate.value, limits).value); }
                    catch {
                        throw report(new PhoneStorageError('LOCAL_CONFLICT', 'The verified import could not be applied to memory; reload is required.'), { latch: true, keepDirty: true });
                    }
                    dirty = false;
                    error = null;
                    emit();
                    return { backupPath: `/user/files/${backupName}`, revision: knownRevision };
                });
            } catch (reason) {
                // Memory is never replaced before verified commit; a failed import
                // therefore rolls back without assigning stale snapshots over edits.
                let changed = true;
                try { changed = snapshot().text !== committedText; }
                catch { /* Invalid live edits remain dirty; do not replace them with a stale snapshot. */ }
                throw report(reason, { latch: blocked || reason?.code === 'CONFLICT', keepDirty: blocked || changed });
            } finally {
                importing = false;
                saving = false;
                emit();
            }
        });
        return task;
    }
    return Object.freeze({
        initPhoneStorage, saveSettingsDebounced, flushPhoneStorage,
        getStorageStatus, exportPhoneBackup, importPhoneBackup,
    });
}
