(() => {
  'use strict';
  const baseUrl = new URL('.', document.currentScript.src);
  const config = window.STAGE_CONFIG || {};
  const service = String(config.supabaseUrl || '').replace(/\/$/, '');
  const key = String(config.publishableKey || '');
  const configured = Boolean(service && key);
  const partialConfiguration = Boolean(service || key) && !configured;
  const storageKey = `stage-session:${baseUrl.pathname}`;
  let session = null, refreshing = null;
  try { session = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { /* No valid local session. */ }

  class CloudError extends Error {
    constructor(message, status = 503, code = '') { super(message); this.status = status; this.code = code; }
  }
  function assertConfig() {
    if (!configured) throw new CloudError('网站尚未连接排期数据库，管理员功能暂未启用。');
    let url;
    try { url = new URL(service); } catch { throw new CloudError('数据库地址配置有误。'); }
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new CloudError('数据库地址须为项目的 HTTPS 地址。');
    if (/^sb_secret_/.test(key)) throw new CloudError('配置中误用了私密密钥，请立即删除并在数据库控制台轮换密钥。');
    if (key.startsWith('eyJ')) {
      try { if (JSON.parse(atob(key.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))).role !== 'anon') throw new Error(); }
      catch { throw new CloudError('请使用 publishable 公钥，不能使用管理员密钥。'); }
    }
  }
  function setSession(value) {
    session = value?.access_token && value?.refresh_token ? {
      access_token: value.access_token, refresh_token: value.refresh_token,
      expires_at: value.expires_at || Math.floor(Date.now() / 1000) + (value.expires_in || 3600),
      user: value.user || null,
    } : null;
    try { if (session) sessionStorage.setItem(storageKey, JSON.stringify(session)); else sessionStorage.removeItem(storageKey); }
    catch { /* This tab can still use an in-memory session. */ }
  }
  async function raw(path, { body, method = 'POST', accessToken, anonymous = false } = {}) {
    assertConfig();
    const headers = { apikey: key, Accept: 'application/json', 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    else if (anonymous && key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(service + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000) });
    let data = null;
    if (response.status !== 204) { try { data = await response.json(); } catch { throw new CloudError('排期服务返回了无法识别的内容。'); } }
    if (!response.ok) {
      const detail = data?.error_description || data?.message || data?.error || '操作未完成，请稍后再试。';
      const status = data?.code === '40001' || /REVISION_CONFLICT/.test(detail) ? 409 : data?.code === '42501' ? (accessToken ? 403 : 401) : response.status;
      throw new CloudError(detail, status, status === 409 ? 'REVISION_CONFLICT' : data?.code || '');
    }
    return data;
  }
  async function accessToken() {
    assertConfig();
    if (!session) throw new CloudError('请先登录管理员账号。', 401);
    if ((session.expires_at || 0) * 1000 <= Date.now() + 60000) {
      if (!refreshing) refreshing = raw('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token }, anonymous: true })
        .then(value => { setSession(value); return session.access_token; })
        .catch(error => { if ([400, 401, 403].includes(error.status)) setSession(null); throw error; })
        .finally(() => { refreshing = null; });
      return refreshing;
    }
    return session.access_token;
  }
  async function rpc(name, args = {}, authenticated = true) {
    return raw(`/rest/v1/rpc/${name}`, { body: args, ...(authenticated ? { accessToken: await accessToken() } : { anonymous: true }) });
  }
  async function edge(name, body, authenticated = true) {
    return raw(`/functions/v1/${name}`, { body, ...(authenticated ? { accessToken: await accessToken() } : { anonymous: true }) });
  }
  async function getRole() { return rpc('get_schedule_role'); }
  async function signIn(email, password) {
    setSession(await raw('/auth/v1/token?grant_type=password', { body: { email: email.trim(), password }, anonymous: true }));
    const role = await getRole();
    if (!['owner', 'editor'].includes(role)) { setSession(null); throw new CloudError('这个账号尚未获得排期管理权限，请联系站主。', 403); }
    return role;
  }
  async function signOut() {
    const value = session;
    try { if (value) await raw('/auth/v1/logout', { body: {}, accessToken: await accessToken() }); }
    finally { setSession(null); }
  }
  async function acceptInvitation(payload) {
    const result = await edge('accept-invitation', payload, false);
    setSession(result.session);
    if (!session || !['owner', 'editor'].includes(await getRole())) { setSession(null); throw new CloudError('邀请已被撤销或尚未获得管理权限，请联系站主。', 403); }
  }
  async function adminResponse(method, payload) {
    try {
      const value = method === 'PUT' ? await rpc('save_schedule', { expected_revision: payload.revision, input_performances: payload.performances }) : await rpc('get_admin_schedule');
      return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      if (!error.status) throw error;
      return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: error.status, headers: { 'Content-Type': 'application/json' } });
    }
  }
  async function downloadBackup() {
    const value = await rpc('export_schedule');
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `jingying-schedule-${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function getPublicSchedule() {
    if (partialConfiguration) throw new CloudError('排期数据库配置不完整。');
    if (configured) return rpc('get_public_schedule', {}, false);
    const response = await fetch(new URL('schedule.json', baseUrl), { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new CloudError('排期暂时无法载入。');
    return response.json();
  }
  window.StageCloud = Object.freeze({ configured, baseUrl, CloudError, getRole, signIn, signOut, acceptInvitation, adminResponse, downloadBackup, getPublicSchedule,
    getEditorList: () => edge('admin-access', { action: 'list' }),
    inviteEditor: email => edge('admin-access', { action: 'invite', email }),
    revokeEditor: email => edge('admin-access', { action: 'revoke', email }),
  });
})();
