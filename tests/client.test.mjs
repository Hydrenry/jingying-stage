import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../cloud-client.js', import.meta.url), 'utf8');
function client({ config = {}, respond = () => new Response('{}'), cached = null } = {}) {
  const calls = [], values = new Map();
  if (cached) values.set('stage-session:/jingying-stage/', JSON.stringify(cached));
  const sandbox = { window: { STAGE_CONFIG: config }, document: { currentScript: { src: 'https://example.github.io/jingying-stage/cloud-client.js' } }, URL, Response, Blob, AbortSignal, Date, atob, setTimeout, sessionStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }, fetch: async (url, options) => { calls.push({ url: String(url), options }); return respond(String(url), options); } };
  vm.runInNewContext(source, sandbox);
  return { api: sandbox.window.StageCloud, calls, values };
}
const config = { supabaseUrl: 'https://test-project.supabase.co', publishableKey: 'sb_publishable_test' };
const authSession = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'fixture-user' } };

test('unconfigured public calendar loads the project-relative seed without enabling management', async () => {
  const { api, calls } = client({ respond: () => Response.json({ performances: [] }) });
  assert.equal(api.configured, false);
  await api.getPublicSchedule();
  assert.equal(calls[0].url, 'https://example.github.io/jingying-stage/schedule.json');
  await assert.rejects(api.getRole(), /尚未连接/);
  assert.equal(calls.length, 1);
});
test('partial configuration and accidental secret keys fail closed', async () => {
  for (const value of [{ supabaseUrl: config.supabaseUrl }, { ...config, publishableKey: 'sb_secret_bad' }]) {
    const { api, calls } = client({ config: value });
    await assert.rejects(api.getPublicSchedule());
    assert.equal(calls.length, 0);
  }
});
test('public reads use anonymous RPC and do not attach an administrator session', async () => {
  const { api, calls } = client({ config, cached: authSession, respond: () => Response.json({ performances: [] }) });
  await api.getPublicSchedule();
  assert.equal(calls[0].url, config.supabaseUrl + '/rest/v1/rpc/get_public_schedule');
  assert.equal(calls[0].options.headers.apikey, config.publishableKey);
  assert.equal(calls[0].options.headers.Authorization, undefined);
});
test('password login verifies server membership and stores a per-tab session without the password', async () => {
  const { api, values, calls } = client({ config, respond: url => Response.json(url.includes('/auth/') ? authSession : 'owner') });
  assert.equal(await api.signIn('owner@example.com', 'fixture-password'), 'owner');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer fixture-access');
  assert.doesNotMatch([...values.values()].join(''), /fixture-password/);
});
test('a valid account without membership is rejected and its local session is cleared', async () => {
  const { api, values } = client({ config, respond: url => Response.json(url.includes('/auth/') ? authSession : null) });
  await assert.rejects(api.signIn('stranger@example.com', 'fixture-password'), /未获得/);
  assert.equal(values.size, 0);
});
test('concurrent protected requests share one refresh and use its new access token', async () => {
  let refreshes = 0;
  const { api, calls } = client({ config, cached: { ...authSession, expires_at: 1 }, respond: async url => { if (url.includes('refresh_token')) { refreshes++; return Response.json({ ...authSession, access_token: 'refreshed-access' }); } return Response.json('editor'); } });
  await Promise.all([api.getRole(), api.getRole()]);
  assert.equal(refreshes, 1);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer refreshed-access');
});
test('optimistic conflict maps to the existing editor 409 contract; denied saves never become success', async () => {
  const { api, calls } = client({ config, cached: authSession, respond: () => Response.json({ code: 'PT409', message: 'REVISION_CONFLICT: stale' }, { status: 409 }) });
  const result = await api.adminResponse('PUT', { revision: 4, performances: [] });
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, 'REVISION_CONFLICT');
  assert.deepEqual(JSON.parse(calls[0].options.body), { expected_revision: 4, input_performances: [] });
});
test('revoked membership maps to 403 for an existing editor session', async () => {
  const { api } = client({ config, cached: authSession, respond: () => Response.json({ code: '42501', message: 'No permission' }, { status: 403 }) });
  assert.equal((await api.adminResponse('PUT', { revision: 1, performances: [] })).status, 403);
});
test('invitations only establish local login after success and a server membership check', async () => {
  const { api, calls } = client({ config, respond: url => Response.json(url.includes('/functions/') ? { session: authSession } : 'editor') });
  await api.acceptInvitation({ token_hash: 'fixture-token-hash', type: 'invite', password: 'fixture-password' });
  assert.equal(calls[0].url, config.supabaseUrl + '/functions/v1/accept-invitation');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer fixture-access');
});
