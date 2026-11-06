import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const prefix = '/scripts/extensions/third-party/acsus-phone-standalone/';
const files = new Map();
const requests = [];
const hostPaths = new Set(['/script.js', '/scripts/extensions.js', '/scripts/openai.js', '/scripts/sse-stream.js', '/scripts/st-context.js', '/scripts/utils.js', '/scripts/personas.js', '/scripts/world-info.js', '/scripts/power-user.js', '/scripts/macros/macro-system.js', '/scripts/extensions/regex/engine.js', '/scripts/preset-manager.js']);
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>独立小手机 · 合成宿主验收</title><link rel="stylesheet" href="${prefix}style.css"><style>body{font-family:system-ui,sans-serif;margin:18px;background:#17202d;color:#eee}.fixture-main{max-width:900px;margin:auto}.text_pole,input,select,textarea{font:inherit}#extensionsMenu{display:flex;gap:12px}.list-group-item{cursor:pointer;padding:8px;border:1px solid #7ca3c4;border-radius:6px}button{font:inherit}#fixture-errors{color:#ff9189;white-space:pre-wrap;overflow-wrap:anywhere} .fa-solid,.fa-regular,.fas{display:inline-block;min-width:1em}.fa-solid:before,.fa-regular:before,.fas:before{content:'·'}</style></head><body><main class="fixture-main"><h1>独立小手机 · 合成宿主验收</h1><p>只有虚构角色和内存文件，不是真实酒馆，不调用真实 AI。</p><nav id="extensionsMenu" aria-label="扩展菜单"></nav><div id="extensions_settings2"></div><p id="fixture-notice" role="status"></p><pre id="fixture-errors" aria-label="运行错误"></pre><p><a href="/__fixture/stats" target="_blank">查看合成存储统计</a></p></main><script type="module">import {eventSource,event_types} from '/__fixture/host.js'; window.addEventListener('error',e=>{document.getElementById('fixture-errors').textContent += String(e.message)+'\\n';});window.addEventListener('unhandledrejection',e=>{document.getElementById('fixture-errors').textContent += String(e.reason?.message||e.reason)+'\\n';}); await import('${prefix}index.js'); await eventSource.emit(event_types.APP_READY);</script></body></html>`;
function respond(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function bodyJson(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 48 * 1024 * 1024) throw new Error('Body too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' && req.method === 'GET') return respond(res, 200, html, 'text/html; charset=utf-8');
    if (pathname === '/favicon.ico') return respond(res, 204, '');
    if (pathname === '/__fixture/host.js') return respond(res, 200, await fs.readFile(path.join(root, 'tests/fixtures/host.js')), 'text/javascript; charset=utf-8');
    if (hostPaths.has(pathname)) return respond(res, 200, "export * from '/__fixture/host.js';\n", 'text/javascript; charset=utf-8');
    if (pathname === '/__fixture/stats') {
      const current = files.get('acsus-phone-standalone.json');
      let data; try { data = current ? JSON.parse(current) : null; } catch { data = null; }
      return respond(res, 200, { syntheticOnly: true, storedFileNames: [...files.keys()], uploads: requests.filter(x => x === 'upload').length, forbiddenRequests: requests.filter(x => x.startsWith('forbidden:')), phoneKeys: Object.keys(data?.phone || {}), chatCount: Object.values(data?.phone?.chats || {}).reduce((n, messages) => n + (Array.isArray(messages) ? messages.length : 0), 0) });
    }
    if (pathname.startsWith('/user/files/') && req.method === 'GET') {
      const name = pathname.slice('/user/files/'.length);
      return files.has(name) ? respond(res, 200, files.get(name)) : respond(res, 404, { error: 'Synthetic file not found' });
    }
    if (pathname === '/api/files/upload' && req.method === 'POST') {
      const value = await bodyJson(req);
      if (typeof value.name !== 'string' || !/^[a-zA-Z0-9_\-.]+$/.test(value.name) || value.name.startsWith('.') || typeof value.data !== 'string') return respond(res, 400, { error: 'Invalid fixture upload' });
      const text = Buffer.from(value.data, 'base64').toString('utf8');
      JSON.parse(text);
      files.set(value.name, text); requests.push('upload');
      return respond(res, 200, { path: `/user/files/${value.name}` });
    }
    if (pathname === '/api/backgrounds/all') return respond(res, 200, { images: [] });
    if (pathname === '/api/backends/chat-completions/status') return respond(res, 200, { data: [{ id: 'synthetic-model' }] });
    if (pathname === '/api/chats/get') return respond(res, 200, []);
    if (pathname === '/api/backends/chat-completions/generate') {
      requests.push('synthetic-generate');
      return respond(res, 200, { choices: [{ message: { content: '（合成测试响应；未调用真实 AI）' } }] });
    }
    if (pathname.startsWith('/api/')) { requests.push(`forbidden:${pathname}`); return respond(res, 403, { error: 'This API is deliberately disabled in the fixture' }); }
    if (pathname.startsWith('/img/') || pathname.startsWith('/User Avatars/') || pathname.startsWith('/characters/')) return respond(res, 200, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#9ecff3"/></svg>', 'image/svg+xml');
    if (pathname.startsWith(prefix)) {
      const relative = pathname.slice(prefix.length);
      if (!relative || /(^|\/)\./.test(relative) || !/\.(js|css)$/.test(relative)) return respond(res, 403, { error: 'Fixture serves runtime JS/CSS only' });
      const resolved = path.resolve(root, relative);
      if (path.relative(root, resolved).startsWith('..')) return respond(res, 403, { error: 'Path traversal denied' });
      const data = await fs.readFile(resolved);
      return respond(res, 200, data, relative.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
    }
    return respond(res, 404, { error: 'Not found' });
  } catch (error) { return respond(res, error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? 'Missing fixture asset' : 'Fixture request failed' }); }
});
server.listen(0, '127.0.0.1', () => {
  console.log(`FIXTURE_URL=http://127.0.0.1:${server.address().port}/`);
  console.log('Synthetic host only; files are held in process memory. Stop this process to discard them.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
