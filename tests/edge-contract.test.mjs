// Local source/handler contract tests with an SDK mock. These do NOT run Deno, GoTrue,
// Postgres/RLS or a deployed Supabase project; native OTP atomicity is provider-owned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const SITE = 'https://example.github.io/jingying/';
const ORIGIN = new URL(SITE).origin;
const OWNER = { id: 'owner-id', email: 'owner@example.com', last_sign_in_at: '2026-10-31T00:00:00Z' };
const EDITOR = { id: 'editor-id', email: 'editor@example.com', last_sign_in_at: '2026-10-31T00:00:00Z' };
let moduleId = 0;

async function fixture(functionName, changes = {}) {
  const state = {
    env: { SITE_URL: SITE, SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-server-key-only', SUPABASE_ANON_KEY: 'test-public-key' },
    users: new Map([[OWNER.id, { ...OWNER }], [EDITOR.id, { ...EDITOR }]]),
    members: new Map([[OWNER.id, { user_id: OWNER.id, role: 'owner', added_at: '2026-10-30' }], [EDITOR.id, { user_id: EDITOR.id, role: 'editor', added_at: '2026-10-31' }]]),
    calls: [], role: 'editor', invalidOtp: false, failPassword: false, failMembership: false,
    ...changes,
  };
  function query() {
    let operation = 'select';
    const filters = {};
    const chain = {
      select() { return chain; },
      eq(key, value) { filters[key] = value; return chain; },
      delete() { operation = 'delete'; return chain; },
      async maybeSingle() {
        if (state.failMembership) return { data: null, error: { message: 'private backend detail' } };
        return { data: state.members.get(filters.user_id) ?? null, error: null };
      },
      async order() { return { data: [...state.members.values()], error: null }; },
      async upsert(value, options) {
        state.calls.push(['upsert', value, options]);
        if (state.failGrant) return { error: { message: 'private grant detail' } };
        if (!state.members.has(value.user_id)) state.members.set(value.user_id, { ...value, added_at: '2026-10-31' });
        return { error: null };
      },
      then(resolve, reject) {
        if (operation === 'delete') {
          const row = state.members.get(filters.user_id);
          if (row && row.role === filters.role) state.members.delete(filters.user_id);
          state.calls.push(['delete', { ...filters }]);
        }
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return chain;
  }
  function createClient(url, key, options) {
    state.calls.push(['createClient', key, options]);
    return {
      from(table) { assert.equal(table, 'schedule_members'); return query(); },
      async rpc(name) { state.calls.push(['rpc', name]); return { data: state.role, error: null }; },
      auth: {
        async getUser(jwt) {
          state.calls.push(['getUser', jwt]);
          const user = jwt === 'owner-jwt' ? OWNER : jwt === 'editor-jwt' ? { ...EDITOR, user_metadata: { role: 'owner' } } : null;
          return { data: { user }, error: user ? null : { status: 401 } };
        },
        admin: {
          async listUsers({ page, perPage }) {
            const users = [...state.users.values()];
            return { data: { users: users.slice((page - 1) * perPage, page * perPage) }, error: null };
          },
          async getUserById(id) { return { data: { user: state.users.get(id) ?? null }, error: null }; },
          async generateLink(input) {
            state.calls.push(['generateLink', input]);
            if (state.failGenerate) return { data: null, error: { status: 429 } };
            let user = [...state.users.values()].find(item => item.email === input.email);
            if (!user) { user = { id: 'new-editor-id', email: input.email, last_sign_in_at: null }; state.users.set(user.id, user); }
            return { data: { user, properties: { hashed_token: 'native-hashed-token-123456789', verification_type: input.type } }, error: null };
          },
        },
        async verifyOtp(input) {
          state.calls.push(['verifyOtp', input]);
          if (state.invalidOtp) return { data: {}, error: { status: 400 } };
          return { data: { user: EDITOR, session: { access_token: 'recipient-access-token', refresh_token: 'recipient-refresh-token', expires_at: 1900000000, user: EDITOR } }, error: null };
        },
        async updateUser(input) {
          state.calls.push(['updateUser', input]);
          if (state.revokeDuringPassword) state.role = null;
          return { data: { user: state.failPassword ? null : EDITOR }, error: state.failPassword ? { message: 'private password detail' } : null };
        },
        async signOut(input) { state.calls.push(['signOut', input]); return { error: null }; },
      },
    };
  }
  const sourcePath = new URL(`../supabase/functions/${functionName}/index.ts`, import.meta.url);
  let source = readFileSync(sourcePath, 'utf8');
  source = source.replace(/^import .* from "npm:@supabase\/supabase-js@2\.118\.0";$/m, 'const createClient = mock.createClient;');
  const id = String(++moduleId);
  globalThis.__edgeContractMocks ??= new Map();
  globalThis.__edgeContractMocks.set(id, { createClient, env: state.env });
  const prolog = `const mock = globalThis.__edgeContractMocks.get('${id}'); const Deno = {env:{get:key=>mock.env[key]},serve:()=>{}};\n`;
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(prolog + source)).toString('base64'));
  return { handler: loaded.handler, state };
}

function request(body, options = {}) {
  const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json', authorization: 'Bearer owner-jwt', ...options.headers });
  if (options.noOrigin) headers.delete('origin');
  if (options.noBearer) headers.delete('authorization');
  const method = options.method || 'POST';
  return new Request('https://example.supabase.co/functions/v1/test', {
    method, headers, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

test('static deployment contract pins the SDK and delegates verification to Auth, not JWT decoding', () => {
  const admin = readFileSync(new URL('../supabase/functions/admin-access/index.ts', import.meta.url), 'utf8');
  const accept = readFileSync(new URL('../supabase/functions/accept-invitation/index.ts', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  assert.match(admin, /supabase-js@2\.118\.0/);
  assert.match(accept, /supabase-js@2\.118\.0/);
  assert.match(admin, /auth\.getUser\(bearer\[1\]\)/);
  assert.doesNotMatch(admin, /atob\(|jwtDecode\(/);
  assert.match(accept, /auth\.verifyOtp/);
  assert.match(accept, /auth\.updateUser\(\{ password: body\.password \}\)/);
  assert.doesNotMatch(accept, /SUPABASE_SERVICE_ROLE_KEY|updateUserById|createUser\(/);
  assert.doesNotMatch(admin, /\.inviteUserByEmail\(|\.resetPasswordForEmail\(|\.signInWithOtp\(/);
  assert.match(config, /\[functions\.admin-access\][\s\S]*?verify_jwt = false/);
  assert.match(config, /\[functions\.accept-invitation\][\s\S]*?verify_jwt = false/);
  assert.match(config, /otp_expiry = 3600/);
});

test('mock SDK: strict origin CORS and preflight never call privileged Auth APIs', async () => {
  for (const name of ['admin-access', 'accept-invitation']) {
    const { handler, state } = await fixture(name);
    const preflight = await handler(request(undefined, { method: 'OPTIONS' }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(state.calls.length, 0);
    const wrong = await handler(request({}, { headers: { origin: 'https://attacker.example' } }));
    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers.get('access-control-allow-origin'), null);
    assert.equal((await handler(request({}, { noOrigin: true }))).status, 403);
  }
});

test('mock SDK: localhost requires an explicit development environment', async () => {
  const { handler, state } = await fixture('admin-access');
  state.env.SITE_URL = 'http://127.0.0.1:5500/project/';
  assert.equal((await handler(request({}, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:5500' } }))).status, 503);
  state.env.ENVIRONMENT = 'development';
  assert.equal((await handler(request({}, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:5500' } }))).status, 204);
});

test('mock SDK: owner authorization checks verified UID membership and ignores user metadata', async () => {
  const { handler, state } = await fixture('admin-access');
  assert.equal((await handler(request({ action: 'list' }, { noBearer: true }))).status, 401);
  assert.equal((await handler(request({ action: 'list' }, { headers: { authorization: 'Bearer invalid-jwt' } }))).status, 401);
  assert.equal((await handler(request({ action: 'list' }, { headers: { authorization: 'Bearer editor-jwt' } }))).status, 403);
  const list = await handler(request({ action: 'list' }));
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { ownerEmail: OWNER.email, editors: [{ email: EDITOR.email, userId: EDITOR.id, addedAt: '2026-10-31', status: 'active' }] });
  assert.equal(state.calls.some(call => call[0] === 'getUser' && call[1] === 'owner-jwt'), true);
  const service = state.calls.find(call => call[0] === 'createClient');
  assert.equal(service[1], 'test-server-key-only');
  assert.equal(service[2].global?.headers?.Authorization, undefined);
});

test('mock SDK: new invitations preserve project base path and put native proof only in fragment', async () => {
  const { handler, state } = await fixture('admin-access');
  const result = await handler(request({ action: 'invite', email: ' New@Example.com ', siteUrl: 'https://attacker.example/' }));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.email, 'new@example.com');
  const link = new URL(body.inviteUrl);
  assert.equal(link.origin, ORIGIN);
  assert.equal(link.pathname, '/jingying/invitation.html');
  assert.equal(link.search, '');
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('type'), 'invite');
  assert.equal('expiresAt' in body, false);
  assert.equal(JSON.stringify(body).includes('test-server-key-only'), false);
  assert.equal(state.calls.find(call => call[0] === 'generateLink')[1].type, 'invite');
  assert.equal(state.members.get('new-editor-id').role, 'editor');
});

test('mock SDK: existing accounts use native recovery, immutable owner and editor-only revocation', async () => {
  const { handler, state } = await fixture('admin-access');
  const reinvite = await handler(request({ action: 'invite', email: EDITOR.email }));
  assert.equal(reinvite.status, 200);
  assert.equal(state.calls.find(call => call[0] === 'generateLink')[1].type, 'recovery');
  assert.equal((await handler(request({ action: 'invite', email: OWNER.email }))).status, 400);
  assert.equal((await handler(request({ action: 'revoke', email: OWNER.email }))).status, 400);
  assert.equal((await handler(request({ action: 'revoke', email: EDITOR.email }))).status, 200);
  assert.equal(state.members.has(EDITOR.id), false);
  assert.deepEqual(state.calls.find(call => call[0] === 'delete')[1], { user_id: EDITOR.id, role: 'editor' });
  assert.equal((await handler(request({ action: 'revoke', email: 'missing@example.com' }))).status, 200);
});

test('mock SDK: input bounds, method checks and service failures are explicit and do not leak details', async () => {
  const { handler, state } = await fixture('admin-access');
  assert.equal((await handler(request({}, { method: 'GET' }))).status, 405);
  assert.equal((await handler(request({ action: 'invite', email: 'bad' }))).status, 400);
  assert.equal((await handler(request('{'))).status, 400);
  assert.equal((await handler(request('x'.repeat(16385)))).status, 413);
  state.failMembership = true;
  const failed = await handler(request({ action: 'list' }));
  assert.equal(failed.status, 503);
  assert.equal(JSON.stringify(await failed.json()).includes('private backend detail'), false);
});

const validAcceptance = { token_hash: 'native-hashed-token-123456789', type: 'invite', password: 'test-password-at-least-12' };

test('mock SDK: acceptance validates before consuming OTP, never uses a service-role password bypass', async () => {
  const { handler, state } = await fixture('accept-invitation');
  assert.equal((await handler(request({ ...validAcceptance, password: 'short' }))).status, 400);
  assert.equal((await handler(request({ ...validAcceptance, password: 'x'.repeat(129) }))).status, 400);
  assert.equal((await handler(request({ ...validAcceptance, type: 'signup' }))).status, 400);
  assert.equal(state.calls.length, 0);
  const result = await handler(request(validAcceptance));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.session.access_token, 'recipient-access-token');
  assert.equal(body.session.refresh_token, 'recipient-refresh-token');
  assert.equal(state.calls.find(call => call[0] === 'createClient')[1], 'test-public-key');
  assert.deepEqual(state.calls.filter(call => ['verifyOtp', 'rpc', 'updateUser'].includes(call[0])).map(call => call[0]), ['verifyOtp', 'rpc', 'updateUser', 'rpc']);
});

test('mock SDK: rejected OTP never changes password; failed password update returns no session', async () => {
  const { handler, state } = await fixture('accept-invitation', { invalidOtp: true });
  assert.equal((await handler(request(validAcceptance))).status, 400);
  assert.equal(state.calls.some(call => call[0] === 'updateUser'), false);
  state.invalidOtp = false;
  state.failPassword = true;
  const failed = await handler(request(validAcceptance));
  assert.equal(failed.status, 400);
  const body = await failed.json();
  assert.match(body.error, /重新邀请/);
  assert.equal('session' in body, false);
  assert.equal(state.calls.some(call => call[0] === 'signOut'), true);
});

test('mock SDK: revoked membership before or during password change never returns a session', async () => {
  const { handler, state } = await fixture('accept-invitation', { role: null });
  assert.equal((await handler(request(validAcceptance))).status, 403);
  assert.equal(state.calls.some(call => call[0] === 'updateUser'), false);
  state.role = 'editor';
  state.revokeDuringPassword = true;
  const result = await handler(request(validAcceptance));
  assert.equal(result.status, 403);
  assert.equal('session' in await result.json(), false);
});
