(() => {
  'use strict';
  const mode = document.body.dataset.authPage;
  const form = document.getElementById('auth-form'), status = document.getElementById('auth-status'), button = document.getElementById('auth-submit');
  const next = new URLSearchParams(location.search).get('next') === 'access' ? 'admin/access.html' : 'admin/';
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token_hash = fragment.get('token_hash') || '', type = fragment.get('type') || '';
  if (mode === 'invitation') history.replaceState(null, '', location.pathname);
  if (!StageCloud.configured) { status.textContent = '网站尚未连接排期数据库，管理员功能暂未启用。'; button.disabled = true; }
  else if (mode === 'invitation' && (!token_hash || !['invite', 'recovery'].includes(type))) { status.textContent = '请从站主发给你的完整邀请链接进入。'; button.disabled = true; }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (button.disabled) return;
    const fields = new FormData(form), password = String(fields.get('password') || '');
    if (mode === 'invitation' && password !== fields.get('confirmPassword')) { status.textContent = '两次输入的密码不一致。'; return; }
    button.disabled = true; const label = button.textContent; button.textContent = '正在处理…'; status.textContent = '';
    try {
      if (mode === 'logout') await StageCloud.signOut();
      else if (mode === 'invitation') await StageCloud.acceptInvitation({ token_hash, type, password });
      else await StageCloud.signIn(String(fields.get('email') || ''), password);
      form.reset(); location.assign(new URL(mode === 'logout' ? './' : next, StageCloud.baseUrl));
    } catch (error) {
      status.textContent = error.name === 'TimeoutError' || error.name === 'TypeError' ? '连接未完成，请检查网络后重试。' : error.message;
      button.disabled = false; button.textContent = label;
    }
  });
})();
