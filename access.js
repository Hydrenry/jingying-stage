(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let snapshot = null, busy = false, pending = null;
  const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
  function status(text, error = false) { $('status-message').textContent = text; $('access-status').dataset.tone = error ? 'error' : 'info'; }
  function controls() { for (const button of document.querySelectorAll('button')) button.disabled = busy; $('grant-button').disabled = busy || !snapshot; }
  async function request(path, body) {
    try {
      if (path === '/api/auth/invitations') return await StageCloud.inviteEditor(body.email);
      if (path === '/api/auth/revoke') return await StageCloud.revokeEditor(body.email);
      return await StageCloud.getEditorList();
    } catch(error) { if (error.status === 401) $('signin-link').hidden = false; throw error; }
  }

  function render() {
    $('owner-email').textContent = snapshot.ownerEmail;
    const editors = snapshot.editors.filter(item => item.status !== 'revoked');
    $('editor-count').textContent = String(editors.length);
    $('editors-list').replaceChildren();
    if (!editors.length) $('editors-list').append(node('p', '目前只有站主可以管理排期。', 'empty-state'));
    for (const editor of editors) {
      const card = node('article', '', 'editor-card'); const info = node('div', '', 'editor-info');
      info.append(node('h3', editor.email, 'editor-email'), node('p', editor.status === 'invited' ? '已授权，等待对方设置密码' : '已授权，可以管理排期', 'editor-added'));
      const actions = node('div', '', 'status-actions');
      const reissue = node('button', '重新邀请', 'secondary-button'); reissue.type = 'button'; reissue.addEventListener('click', () => confirmAction('重新邀请', '为对方重新生成设置密码的链接？已有登录不会因此自动退出。', () => invite(editor.email)));
      const revoke = node('button', '撤销权限', 'revoke-button'); revoke.type = 'button'; revoke.addEventListener('click', () => confirmAction('撤销权限', `撤销 ${editor.email} 的管理权限？`, () => revokeEmail(editor.email)));
      actions.append(reissue, revoke); card.append(info, actions); $('editors-list').append(card);
    }
  }
  async function reload() {
    if (busy) return; busy = true; controls();
    try { snapshot = await request('/api/auth/editors'); render(); status('管理员名单已更新。'); }
    catch (error) { status(error.message || '网络连接未完成，请刷新名单。', true); }
    finally { busy = false; controls(); }
  }
  async function invite(email) {
    if (busy) return; busy = true; controls(); $('invitation-result').hidden = true; $('invite-url').value = '';
    try {
      const result = await request('/api/auth/invitations', { email });
      $('invite-url').value = result.inviteUrl;
      $('invite-expiry').textContent = '邀请只能使用一次，有效期按站点设置。离开页面后不再显示此链接。';
      $('invitation-result').hidden = false;
      status(`已生成 ${result.email} 的邀请，请复制并手动发给本人。`);
      snapshot = await request('/api/auth/editors'); render();
    } catch (error) { status(error.message || '暂时无法确认结果。请刷新名单核对，必要时重新邀请。', true); }
    finally { busy = false; controls(); }
  }
  async function revokeEmail(email) {
    if (busy) return; busy = true; controls();
    try { await request('/api/auth/revoke', { email }); $('invitation-result').hidden = true; $('invite-url').value = ''; snapshot = await request('/api/auth/editors'); render(); status(`已撤销 ${email} 的权限。`); }
    catch (error) { status(error.message || '暂时无法确认结果，请刷新名单核对。', true); }
    finally { busy = false; controls(); }
  }
  function confirmAction(title, text, action) { if (busy) return; pending = action; $('confirm-title').textContent = title; $('confirm-text').textContent = text; $('confirm-dialog').showModal(); }
  $('cancel-action').addEventListener('click', () => { pending = null; $('confirm-dialog').close(); });
  $('confirm-action').addEventListener('click', () => { const action = pending; pending = null; $('confirm-dialog').close(); action?.(); });
  $('grant-form').addEventListener('submit', event => {
    event.preventDefault(); if (busy || !snapshot) return;
    const email = $('editor-email').value.trim().toLowerCase();
    if (snapshot.editors.some(item => item.email === email && item.status !== 'revoked')) confirmAction('重新邀请', '这个邮箱已有授权。是否重新生成设置密码的链接？', () => invite(email));
    else invite(email);
  });
  $('copy-invite').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('invite-url').value); status('邀请链接已复制，请只发给被邀请人。'); } catch { $('invite-url').select(); status('请手动复制上方邀请链接。'); } });
  $('reload-editors').addEventListener('click', reload);
  reload();
})();
