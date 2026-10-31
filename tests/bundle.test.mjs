import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
const root = fileURLToPath(new URL('../', import.meta.url));
const pages = ['index.html', 'login.html', 'invitation.html', 'logout.html', 'admin/index.html', 'admin/access.html'];

function validPublicConfiguration(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  if (Object.keys(config).some(name => !['supabaseUrl', 'publishableKey'].includes(name))) return false;
  const { supabaseUrl, publishableKey } = config;
  if (typeof supabaseUrl !== 'string' || typeof publishableKey !== 'string') return false;
  if (supabaseUrl !== supabaseUrl.trim() || publishableKey !== publishableKey.trim()) return false;
  if (!supabaseUrl && !publishableKey) return true;
  if (!supabaseUrl || !publishableKey) return false;
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) return false;
  } catch { return false; }
  if (/^sb_publishable_[A-Za-z0-9_-]{12,}$/.test(publishableKey)) return true;
  // Legacy anon JWTs are public, but service-role and signed-in user JWTs must never ship.
  if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(publishableKey)) return false;
  try { return JSON.parse(Buffer.from(publishableKey.split('.')[1], 'base64url').toString('utf8')).role === 'anon'; }
  catch { return false; }
}

function browserConfiguration(source) {
  const context = vm.createContext(Object.create(null));
  try {
    vm.runInContext('globalThis.window = Object.create(null)', context, { timeout: 1000 });
    vm.runInContext(source, context, { timeout: 1000 });
    return context.window.STAGE_CONFIG;
  } catch {
    // Never include config source or credential values in assertion output.
    assert.fail('config.js must provide a valid browser configuration object');
  }
}

test('every page uses existing project-relative scripts, images and navigation', async () => {
  for (const page of pages) {
    const html = await readFile(resolve(root, page), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const value = match[1];
      if (value.startsWith('#') || value.startsWith('data:') || /^https?:/.test(value)) continue;
      assert.ok(!value.startsWith('/'), `${page}: ${value} would escape the repository path`);
      const target = resolve(dirname(resolve(root, page)), value.split(/[?#]/)[0]);
      assert.ok((await stat(target)).isFile() || (await stat(target)).isDirectory(), `${page}: missing ${value}`);
    }
    assert.match(html, /name="referrer" content="no-referrer"/);
    assert.match(html, /script-src 'self'/);
    assert.ok(html.indexOf('config.js') < html.indexOf('cloud-client.js'));
  }
});
test('public seed preserves 84 original records without exposing undecided projects or local paths', async () => {
  const seed = JSON.parse(await readFile(resolve(root, 'schedule.json'), 'utf8'));
  assert.equal(seed.performances.length, 84);
  assert.equal(seed.performances.filter(row => row.time === null).length, 8);
  assert.equal(new Set(seed.performances.map(row => row.id)).size, 84);
  assert.equal(seed.undated, undefined);
  assert.doesNotMatch(JSON.stringify(seed), /\/Users\/|file:\/\/|updated_by/);
});
test('public calendar keeps requested branding and excludes management and removed sections', async () => {
  const home = await readFile(resolve(root, 'index.html'), 'utf8');
  assert.match(home, /BLING ON STAGE/);
  assert.match(home, /assets\/portrait.jpg/);
  assert.doesNotMatch(home, /href="[^\"]*admin|待核实线索|实演确认|收录依据/);
});
test('browser configuration is either a blank pair or an HTTPS project with a public key', async () => {
  const source = await readFile(resolve(root, 'config.js'), 'utf8');
  assert.ok(validPublicConfiguration(browserConfiguration(source)),
    'config.js must contain only a blank URL/key pair or an HTTPS project URL and public publishable/anon key; never a secret or service-role key');
});
test('configuration validation accepts public setup while rejecting incomplete or private credentials', () => {
  const publicSetup = { supabaseUrl: 'https://fixture-project.supabase.co', publishableKey: 'sb_publishable_fixture_public_browser_key' };
  const legacyKey = role => [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role })).toString('base64url'),
    'fixture-signature',
  ].join('.');
  assert.ok(validPublicConfiguration({ supabaseUrl: '', publishableKey: '' }));
  assert.ok(validPublicConfiguration(publicSetup));
  assert.ok(validPublicConfiguration({ ...publicSetup, publishableKey: legacyKey('anon') }));
  for (const invalid of [
    { ...publicSetup, publishableKey: '' },
    { ...publicSetup, supabaseUrl: '' },
    { ...publicSetup, supabaseUrl: 'http://fixture-project.supabase.co' },
    { ...publicSetup, supabaseUrl: 'https://name:password@fixture-project.supabase.co' },
    { ...publicSetup, supabaseUrl: 'https://fixture-project.supabase.co/rest/v1' },
    { ...publicSetup, publishableKey: 'sb_secret_fixture_private_key' },
    { ...publicSetup, publishableKey: legacyKey('service_role') },
    { ...publicSetup, publishableKey: legacyKey('authenticated') },
    { ...publicSetup, serviceRoleKey: 'private-value-must-not-be-configured' },
  ]) assert.equal(validPublicConfiguration(invalid), false);
});
test('admin UI loads data only after a server role check and uses cloud writes', async () => {
  const admin = await readFile(resolve(root, 'admin.js'), 'utf8');
  assert.match(admin, /await StageCloud.getRole\(\)/);
  assert.match(admin, /await StageCloud.adminResponse\(method, payload\)/);
  assert.doesNotMatch(admin, /fetch\('\/(?:api|admin)/);
  const auth = await readFile(resolve(root, 'auth.js'), 'utf8');
  assert.match(auth, /history.replaceState/);
  assert.match(auth, /网站尚未连接排期数据库/);
  assert.match(auth, /button.disabled = true/);
});
