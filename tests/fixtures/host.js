// Synthetic host only. No production state, credentials, paid requests or user files.
const avatar = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%22100%22%20height=%22100%22%3E%3Crect%20width=%22100%22%20height=%22100%22%20fill=%22%239ecff3%22/%3E%3Ctext%20x=%2250%22%20y=%2260%22%20text-anchor=%22middle%22%20font-size=%2230%22%3ET%3C/text%3E%3C/svg%3E';
export const name1 = '测试用户';
export const user_avatar = 'fixture-user.png';
export const this_chid = 0;
export const main_api = 'openai';
export const characters = [{ name: '测试角色', avatar: 'fixture-character.png', chat: 'fixture-chat', data: { name: '测试角色', description: '仅供测试的合成角色。', personality: '', scenario: '', creator_notes: '独立小手机测试', extensions: {} } }];
export const chat = [];
export const extension_settings = Object.freeze({ regex: [] });
export const power_user = { persona_description: '', personas: {}, persona_descriptions: {} };
export const world_info = [];
export const oai_settings = { chat_completion_source: 'openai', openai_model: 'synthetic-model', stream_openai: false, image_inlining: false, temperature: 0.7, max_tokens: 512, names_behavior: 0 };
export const chat_completion_sources = { OPENAI: 'openai', CUSTOM: 'custom', OPENROUTER: 'openrouter', CLAUDE: 'claude', MAKERSUITE: 'makersuite' };
const handlers = new Map();
export const event_types = { APP_READY: 'app_ready', CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready', GENERATION_STARTED: 'generation_started', GENERATION_STOPPED: 'generation_stopped', GENERATION_ENDED: 'generation_ended', MESSAGE_RECEIVED: 'message_received', CHAT_CHANGED: 'chat_changed', MESSAGE_DELETED: 'message_deleted' };
export const eventSource = {
  on(name, callback) { const set = handlers.get(name) || new Set(); set.add(callback); handlers.set(name, set); },
  once(name, callback) { const once = (...args) => { this.removeListener(name, once); return callback(...args); }; this.on(name, once); },
  removeListener(name, callback) { handlers.get(name)?.delete(callback); },
  off(name, callback) { this.removeListener(name, callback); },
  async emit(name, ...args) { for (const callback of [...handlers.get(name) || []]) await callback(...args); },
};
export function getRequestHeaders() { return { 'Content-Type': 'application/json' }; }
export function saveSettingsDebounced() { throw new Error('Fixture: writing host settings is forbidden'); }
export function getThumbnailUrl() { return avatar; }
export function getUserAvatar() { return avatar; }
export function extractMessageFromData(value) { return value?.choices?.[0]?.message?.content || value?.content || (typeof value === 'string' ? value : ''); }
export function getContext() { return { characters, chat, characterId: this_chid, name1, name2: '测试角色', extensionSettings: extension_settings, powerUserSettings: power_user, eventSource, eventTypes: event_types, substituteParams: value => String(value).replaceAll('{{user}}', name1).replaceAll('{{char}}', '测试角色') }; }
export function regexFromString(value) { try { const match = String(value).match(/^\/(.*)\/([a-z]*)$/); return match ? new RegExp(match[1], match[2]) : new RegExp(value); } catch { return undefined; } }
export function getBase64Async(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }); }
export async function loadWorldInfo() { return { entries: {} }; }
export function getPresetManager() { return { readPresetExtensionField: () => [], getPresetList: () => ({ preset_names: [], presets: [] }) }; }
export const SCRIPT_TYPES = { GLOBAL: 0, SCOPED: 1, PRESET: 2 };
export function getScriptsByType() { return []; }
const registry = new Map();
export const macros = { register: (name, value) => registry.set(name, value), registry: { unregisterMacro: name => registry.delete(name) } };
export function getEventSourceStream() { return new TransformStream({ transform(chunk, controller) { controller.enqueue(chunk); } }); }
export function getStreamingReply(value) { return value?.choices?.[0]?.delta?.content || ''; }
export async function sendOpenAIRequest() { return { choices: [{ message: { content: '（仅为合成宿主响应，未调用真实 AI）' } }] }; }

if (typeof window !== 'undefined') {
  window.SillyTavern = { getContext };
  const notice = message => { const output = document.getElementById('fixture-notice'); if (output) output.textContent = String(message); };
  window.toastr = { success: notice, info: notice, warning: notice, error: notice };
  const jq = input => ({ sortable() { return this; }, on() { return this; }, off() { return this; }, trigger() { return this; }, find(selector) { return jq(selector); }, val() { return typeof input === 'string' ? document.querySelector(input)?.value : input?.value; }, each(fn) { const list = typeof input === 'string' ? document.querySelectorAll(input) : [input]; list.forEach((el, i) => fn.call(el, i, el)); return this; } });
  jq.fn = { sortable() {} };
  window.$ = window.jQuery = jq;
}
