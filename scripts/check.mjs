import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const allowedHost = new Set([
  '/script.js', '/scripts/extensions.js', '/scripts/openai.js', '/scripts/sse-stream.js',
  '/scripts/st-context.js', '/scripts/utils.js', '/scripts/personas.js', '/scripts/world-info.js',
  '/scripts/power-user.js', '/scripts/macros/macro-system.js',
  '/scripts/extensions/regex/engine.js', '/scripts/preset-manager.js',
]);
const errors = [];
const external = new Set();
async function walk(directory) {
  const out = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'artifacts', '.runtime'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) errors.push(`Symlink forbidden: ${path.relative(root, file)}`);
    else if (entry.isDirectory()) out.push(...await walk(file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}
const allFiles = await walk(root);
const runtime = allFiles.filter(file => file.endsWith('.js') && !/[/\\](tests|scripts)[/\\]/.test(path.relative(root, file)));
async function resolveImport(specifier, file) {
  if (specifier.startsWith('/')) {
    external.add(specifier);
    if (!allowedHost.has(specifier)) errors.push(`Unexpected host import ${specifier} in ${path.relative(root, file)}`);
    return;
  }
  if (!specifier.startsWith('.')) { errors.push(`Nonlocal import ${specifier}`); return; }
  const resolved = path.resolve(path.dirname(file), specifier);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) { errors.push(`Escaping local import ${specifier}`); return; }
  try { if (!(await fs.stat(resolved)).isFile()) throw new Error('not a file'); }
  catch { errors.push(`Missing import ${specifier} in ${path.relative(root, file)}`); }
}
for (const file of runtime) {
  const text = await fs.readFile(file, 'utf8');
  try {
    const module = new vm.SourceTextModule(text, { identifier: file });
    for (const specifier of module.dependencySpecifiers) await resolveImport(specifier, file);
  } catch (error) { errors.push(`Syntax: ${path.relative(root, file)}: ${error.message}`); }
  for (const match of text.matchAll(/import\(\s*(['"])([^'"]+)\1\s*\)/g)) await resolveImport(match[2], file);
  if (file.includes(path.join('toolkit', 'phone'))) {
    if (/extension_settings(?:\?\.)?\.?(?:acsusPawsPuffs|phone)\b/.test(text)) errors.push(`Legacy writable storage in ${path.relative(root, file)}`);
    if (/^import\s*\{[^}]*saveSettingsDebounced[^}]*\}\s*from\s*['"]\/script\.js/m.test(text)) errors.push(`Host settings saver in ${path.relative(root, file)}`);
    if (/fetch\(\s*['"]\/api\/files\/delete/.test(text)) errors.push(`Shared-media deletion in ${path.relative(root, file)}`);
    if (/`phone_draft_/.test(text)) errors.push(`Shared draft key in ${path.relative(root, file)}`);
  }
}
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
for (const key of ['js', 'css']) {
  if (!allFiles.includes(path.resolve(root, manifest[key]))) errors.push(`Missing manifest ${key}`);
}
const snapshot = JSON.parse(await fs.readFile(path.join(root, 'docs/upstream-snapshot.json'), 'utf8'));
const expectedLicense = snapshot.files.find(file => file.path === 'LICENSE')?.sha256;
const license = await fs.readFile(path.join(root, 'LICENSE'));
if (crypto.createHash('sha256').update(license).digest('hex') !== expectedLicense) errors.push('Original LICENSE has changed');
for (const file of allFiles) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  if (/^(?:settings|secrets)\.json$/.test(path.basename(file)) || /\.(?:env|pem|key)$/.test(file)) errors.push(`Private file forbidden: ${relative}`);
  if (!/\.(?:js|mjs|json|md|css|html)$/.test(file)) continue;
  const text = await fs.readFile(file, 'utf8');
  // Match assembled patterns so this checker does not match its own expressions.
  const secretPatterns = [new RegExp('gh' + '[pousr]_[A-Za-z0-9]{30,}'), new RegExp('github' + '_pat_[A-Za-z0-9_]{40,}'), new RegExp('sk' + '-[A-Za-z0-9]{32,}'), /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
  if (secretPatterns.some(pattern => pattern.test(text))) errors.push(`Credential-shaped content: ${relative}`);
  if (/C:[\\/]Users[\\/]/i.test(text)) errors.push(`Local user path in publishable source: ${relative}`);
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ result: 'PASS', runtimeModules: runtime.length, sourceFiles: allFiles.length, hostModules: [...external].sort(), licensePreserved: true, privacyPatternScan: 'passed; not a complete security audit' }, null, 2));
}
