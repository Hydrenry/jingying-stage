(() => {
  'use strict';

  const editableFields = ['title', 'date', 'time', 'city', 'venue', 'role', 'note'];
  const byId = (id) => document.getElementById(id);
  const ui = {
    newButton: byId('new-performance'),
    reloadButton: byId('reload-data'),
    signinLink: byId('signin-link'),
    statusPanel: byId('status-panel'),
    statusMessage: byId('status-message'),
    dataMeta: byId('data-meta'),
    search: byId('search'),
    month: byId('month-filter'),
    activeTab: byId('active-tab'),
    trashTab: byId('trash-tab'),
    listTitle: byId('list-title'),
    listSummary: byId('list-summary'),
    count: byId('record-count'),
    list: byId('record-list'),
    editor: byId('editor-panel'),
    placeholder: byId('editor-placeholder'),
    editorContent: byId('editor-content'),
    editorTitle: byId('editor-title'),
    draftState: byId('draft-state'),
    form: byId('schedule-form'),
    fieldset: byId('form-fields'),
    formError: byId('form-error'),
    save: byId('save-performance'),
    cancel: byId('cancel-edit'),
    fields: Object.fromEntries(editableFields.map((field) => [field, byId(`field-${field}`)])),
  };

  const state = {
    revision: null,
    updatedAt: '',
    records: [],
    loaded: false,
    loading: false,
    saving: false,
    mustReload: false,
    view: 'active',
    editorMode: null,
    selectedId: null,
    newId: null,
    baseline: null,
  };

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = String(value);
    return element;
  }

  function valuesFromRecord(record) {
    return Object.fromEntries(editableFields.map((field) => [field, field === 'time' ? record[field] || null : String(record[field] ?? '')]));
  }

  function formValues() {
    return Object.fromEntries(editableFields.map((field) => [field, field === 'time' ? ui.fields[field].value || null : ui.fields[field].value]));
  }

  function isDirty() {
    return state.editorMode !== null && JSON.stringify(formValues()) !== JSON.stringify(state.baseline);
  }

  function busy() {
    return state.loading || state.saving;
  }

  function canWrite() {
    return state.loaded && !busy() && !state.mustReload;
  }

  function setStatus(message, tone = 'info', offerSignin = false) {
    ui.statusMessage.textContent = message;
    ui.statusPanel.dataset.tone = tone;
    ui.statusPanel.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    ui.signinLink.hidden = !offerSignin;
  }

  function showFormError(message = '') {
    ui.formError.textContent = message;
    ui.formError.hidden = !message;
  }

  function syncControls() {
    ui.newButton.disabled = !state.loaded || busy();
    ui.reloadButton.disabled = busy();
    ui.search.disabled = !state.loaded || state.loading;
    ui.month.disabled = !state.loaded || state.loading;
    ui.activeTab.disabled = busy();
    ui.trashTab.disabled = busy();
    ui.fieldset.disabled = busy() || !state.loaded;
    ui.save.disabled = !canWrite() || !isDirty();
    ui.cancel.disabled = busy();
    ui.save.textContent = state.saving ? '正在保存…' : '保存排期';
    ui.list.setAttribute('aria-busy', String(busy()));
    ui.draftState.textContent = isDirty() ? '有未保存的修改' : state.editorMode === 'new' ? '填写后保存' : '内容已保存';
    ui.draftState.dataset.dirty = String(isDirty());
    for (const button of ui.list.querySelectorAll('button')) {
      button.disabled = button.dataset.action === 'edit' ? busy() : !canWrite();
    }
  }

  function dateLabel(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    if (!match) return String(date || '日期待补充');
    return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
  }

  function updatedLabel(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dateLabel(value);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '暂无记录';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date) + '（北京时间）';
  }

  function populateMonths() {
    const previousValue = ui.month.value;
    const months = [...new Set(state.records.map((record) => String(record.date || '').slice(0, 7)).filter((month) => /^\d{4}-\d{2}$/.test(month)))].sort().reverse();
    const options = [node('option', '', '全部月份')];
    options[0].value = '';
    for (const month of months) {
      const option = node('option', '', `${month.slice(0, 4)}年${Number(month.slice(5))}月`);
      option.value = month;
      options.push(option);
    }
    ui.month.replaceChildren(...options);
    ui.month.value = months.includes(previousValue) ? previousValue : '';
  }

  function recordButton(label, action, record) {
    const button = node('button', action === 'delete' ? 'danger-button' : 'secondary-button', label);
    button.type = 'button';
    button.dataset.action = action;
    button.setAttribute('aria-label', `${label}：${record.title}，${dateLabel(record.date)}`);
    button.addEventListener('click', () => {
      if (action === 'edit') openEditor(record);
      else changeDeletedState(record, action === 'delete');
    });
    return button;
  }

  function renderList() {
    const activeCount = state.records.filter((record) => !record.deletedAt).length;
    const trashCount = state.records.length - activeCount;
    const isTrash = state.view === 'trash';
    ui.listTitle.textContent = isTrash ? '回收站' : '排期列表';
    ui.activeTab.textContent = `排期列表 ${activeCount}`;
    ui.trashTab.textContent = `回收站 ${trashCount}`;
    ui.activeTab.classList.toggle('is-active', !isTrash);
    ui.trashTab.classList.toggle('is-active', isTrash);
    ui.activeTab.setAttribute('aria-pressed', String(!isTrash));
    ui.trashTab.setAttribute('aria-pressed', String(isTrash));
    if (!state.loaded) {
      ui.count.textContent = '—';
      ui.listSummary.textContent = state.loading ? '正在读取排期…' : '尚未载入排期';
      ui.list.replaceChildren(node('p', 'empty-state', state.loading ? '正在打开排期本，请稍候…' : '暂时无法读取排期，请点击“重新加载”。'));
      syncControls();
      return;
    }
    const words = ui.search.value.trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
    const month = ui.month.value;
    const viewRecords = state.records.filter((record) => Boolean(record.deletedAt) === isTrash);
    const filtered = viewRecords.filter((record) => {
      const date = String(record.date || '');
      if (month && !date.startsWith(`${month}-`)) return false;
      const searchable = [record.title, record.city, date, date.replace(/-/g, '/'), dateLabel(date)].join(' ').toLocaleLowerCase('zh-CN');
      return words.every((word) => searchable.includes(word));
    }).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.time || '99:99').localeCompare(String(b.time || '99:99')) || String(a.title).localeCompare(String(b.title), 'zh-CN') || a.id.localeCompare(b.id));
    ui.count.textContent = String(filtered.length);
    ui.listSummary.textContent = isTrash
      ? `回收站共 ${viewRecords.length} 条，当前显示 ${filtered.length} 条。恢复后会重新出现在访客页面。`
      : `共 ${viewRecords.length} 条排期，当前显示 ${filtered.length} 条。按日期和时间排序。`;
    ui.dataMeta.textContent = `排期 ${activeCount} 条 · 回收站 ${trashCount} 条 · 最近更新：${updatedLabel(state.updatedAt)}`;
    if (!filtered.length) {
      const message = words.length || month ? '没有符合筛选条件的排期，试试更换搜索词或月份。' : isTrash ? '回收站是空的。删除的排期会保留在这里。' : '还没有排期，点击“新增排期”写下第一条。';
      ui.list.replaceChildren(node('p', 'empty-state', message));
      syncControls();
      return;
    }
    const cards = filtered.map((record) => {
      const article = node('article', 'record-card');
      article.dataset.selected = String(record.id === state.selectedId && state.editorMode === 'edit');
      const main = node('div', 'record-main');
      main.append(node('p', 'record-date', `${dateLabel(record.date)} · ${record.time || '时间待补充'}`));
      main.append(node('h3', '', record.title));
      const location = [record.city, record.venue].filter(Boolean).join(' · ');
      main.append(node('p', 'record-location', location || '地点待补充'));
      if (record.role) main.append(node('p', 'record-role', `角色：${record.role}`));
      if (record.note) main.append(node('p', 'record-note', record.note));
      if (isTrash) main.append(node('p', 'deleted-label', `移入回收站：${updatedLabel(record.deletedAt)}`));
      const actions = node('div', 'record-actions');
      if (isTrash) actions.append(recordButton('恢复排期', 'restore', record));
      else actions.append(recordButton('编辑', 'edit', record), recordButton('移入回收站', 'delete', record));
      article.append(main, actions);
      return article;
    });
    ui.list.replaceChildren(...cards);
    syncControls();
  }

  function confirmDiscard(message = '还有未保存的输入。继续会放弃这些输入，确定继续吗？') {
    return !isDirty() || window.confirm(message);
  }

  function focusEditor() {
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ui.editor.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    ui.fields.title.focus({ preventScroll: true });
  }

  function fillEditor(record) {
    const values = valuesFromRecord(record);
    for (const field of editableFields) {
      ui.fields[field].value = values[field] ?? '';
      ui.fields[field].setCustomValidity('');
    }
    state.baseline = formValues();
    showFormError();
    ui.placeholder.hidden = true;
    ui.editorContent.hidden = false;
    ui.editorTitle.textContent = state.editorMode === 'new' ? '新增排期' : '编辑排期';
    syncControls();
  }

  function openEditor(record) {
    if (!state.loaded || busy()) return;
    if (record && state.editorMode === 'edit' && state.selectedId === record.id) {
      focusEditor();
      return;
    }
    if (!record && state.editorMode === 'new') {
      focusEditor();
      return;
    }
    if (!confirmDiscard()) return;
    state.editorMode = record ? 'edit' : 'new';
    state.selectedId = record ? record.id : null;
    state.newId = null;
    fillEditor(record || {});
    renderList();
    focusEditor();
  }

  function clearEditor() {
    state.editorMode = null;
    state.selectedId = null;
    state.newId = null;
    state.baseline = null;
    ui.form.reset();
    showFormError();
    ui.placeholder.hidden = false;
    ui.editorContent.hidden = true;
  }

  function validSnapshot(value) {
    return value && Number.isSafeInteger(value.revision) && value.revision >= 0
      && typeof value.updatedAt === 'string' && Array.isArray(value.performances)
      && value.performances.every((record) => record && typeof record.id === 'string' && typeof record.title === 'string' && typeof record.date === 'string')
      && new Set(value.performances.map((record) => record.id)).size === value.performances.length;
  }

  async function request(method, payload) {
    let response;
    try {
      response = await StageCloud.adminResponse(method, payload);
    } catch {
      const error = new Error(method === 'PUT'
        ? '网络连接中断，暂时无法确认这次保存结果。输入已保留，请重新加载最新排期核对后再保存。'
        : '暂时无法连接排期服务。请检查网络后重新加载；现有输入会继续保留。');
      error.needsReload = method === 'PUT';
      throw error;
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // A non-JSON response must never be treated as a successful save.
    }
    if (!response.ok) {
      const messages = {
        401: '登录状态已过期。输入已保留，请重新登录，再重新加载排期。',
        403: '当前登录状态无法管理排期。输入已保留，请使用管理员账号重新登录。',
        409: '排期已在其他页面更新，这次没有保存。你的输入仍在，请重新加载最新排期后核对。',
        503: '排期服务或身份验证暂时不可用。输入已保留，可以重新登录后再重新加载。',
      };
      const detail = data && typeof data.error === 'string' ? data.error : '';
      const error = new Error(messages[response.status] || (detail ? `未能保存或读取排期：${detail}` : `排期服务返回错误（${response.status}）。输入已保留，请稍后重试。`));
      error.needsReload = [401, 403, 409, 503].includes(response.status);
      error.offerSignin = [401, 403, 503].includes(response.status);
      throw error;
    }
    if (!validSnapshot(data)) {
      const error = new Error('服务器返回的数据不完整，暂不能确认结果。输入已保留，请重新加载最新排期核对。');
      error.needsReload = true;
      throw error;
    }
    return data;
  }

  function applySnapshot(snapshot) {
    state.records = snapshot.performances;
    state.revision = snapshot.revision;
    state.updatedAt = snapshot.updatedAt;
    state.loaded = true;
    state.mustReload = false;
    populateMonths();
  }

  async function loadSchedule(isReload = false) {
    if (busy()) return;
    if (isReload && !confirmDiscard('重新加载成功后会放弃未保存的输入。请先复制需要保留的内容，确定重新加载吗？')) return;
    state.loading = true;
    setStatus('正在读取最新排期，请稍候…', 'loading');
    renderList();
    try {
      const snapshot = await request('GET');
      applySnapshot(snapshot);
      clearEditor();
      setStatus('已载入最新排期。选择一条编辑，或新增排期。', 'info');
    } catch (error) {
      if (error.needsReload) state.mustReload = true;
      setStatus(error.message || '暂时无法读取排期，请重新加载。', 'error', Boolean(error.offerSignin));
    } finally {
      state.loading = false;
      renderList();
    }
  }

  async function persist(nextRecords, onSuccess) {
    if (!canWrite()) return;
    state.saving = true;
    setStatus('正在保存排期，请稍候…', 'loading');
    showFormError();
    syncControls();
    try {
      const snapshot = await request('PUT', { revision: state.revision, performances: nextRecords });
      applySnapshot(snapshot);
      onSuccess();
      setStatus('已保存，访客页面会自动同步', 'success');
    } catch (error) {
      if (error.needsReload) state.mustReload = true;
      setStatus(error.message || '保存失败，输入已保留，请稍后重试。', 'error', Boolean(error.offerSignin));
    } finally {
      state.saving = false;
      renderList();
    }
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  async function saveForm(event) {
    event.preventDefault();
    if (!canWrite() || state.editorMode === null) return;
    const values = formValues();
    ui.fields.title.setCustomValidity(values.title.trim() ? '' : '请填写剧目或活动名称。');
    ui.fields.date.setCustomValidity(validDate(values.date) ? '' : '请选择完整、有效的演出日期。');
    ui.fields.time.setCustomValidity(values.time === null || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(values.time) ? '' : '请填写有效时间，或将时间留空。');
    if (!ui.form.reportValidity()) return;
    const editedValues = { ...values, title: values.title.trim() };
    const isNew = state.editorMode === 'new';
    let selectedId = state.selectedId;
    let nextRecords;
    if (isNew) {
      if (!state.newId) {
        if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
          showFormError('当前浏览器暂不支持新增排期。请在较新的浏览器中打开网站，输入仍保留在这里。');
          return;
        }
        state.newId = globalThis.crypto.randomUUID();
      }
      selectedId = state.newId;
      nextRecords = [...state.records, { id: selectedId, ...editedValues, status: '待确认', isDemo: false, deletedAt: null }];
    } else {
      const original = state.records.find((record) => record.id === selectedId);
      if (!original || original.deletedAt) {
        showFormError('这条排期已不在当前列表中。输入已保留，请重新加载核对。');
        state.mustReload = true;
        syncControls();
        return;
      }
      // Preserve every other property of the original record, including its ID.
      nextRecords = state.records.map((record) => record.id === selectedId ? { ...record, ...editedValues } : record);
    }
    await persist(nextRecords, () => {
      state.editorMode = 'edit';
      state.selectedId = selectedId;
      state.newId = null;
      const saved = state.records.find((record) => record.id === selectedId);
      if (saved) fillEditor(saved);
      else clearEditor();
    });
  }

  async function changeDeletedState(record, shouldDelete) {
    if (!canWrite()) return;
    const current = state.records.find((item) => item.id === record.id);
    if (!current) return;
    const selectedIsAffected = state.editorMode === 'edit' && state.selectedId === record.id;
    if (shouldDelete) {
      const warning = selectedIsAffected && isDirty() ? '这条排期有未保存的输入，移入回收站后会放弃这些输入。\n\n' : '';
      if (!window.confirm(`${warning}将「${record.title}」移入回收站？访客页面将不再显示，之后可以恢复。`)) return;
    }
    const nextRecords = state.records.map((item) => item.id === record.id ? { ...item, deletedAt: shouldDelete ? new Date().toISOString() : null } : item);
    await persist(nextRecords, () => {
      if (selectedIsAffected) clearEditor();
    });
  }

  function switchView(view) {
    if (busy() || state.view === view || !confirmDiscard()) return;
    clearEditor();
    state.view = view;
    renderList();
  }

  ui.newButton.addEventListener('click', () => openEditor(null));
  ui.reloadButton.addEventListener('click', () => loadSchedule(true));
  ui.form.addEventListener('submit', saveForm);
  ui.form.addEventListener('input', (event) => {
    if (event.target && typeof event.target.setCustomValidity === 'function') event.target.setCustomValidity('');
    showFormError();
    syncControls();
  });
  ui.cancel.addEventListener('click', () => {
    if (busy() || !confirmDiscard()) return;
    clearEditor();
    renderList();
    ui.newButton.focus();
  });
  ui.search.addEventListener('input', renderList);
  ui.month.addEventListener('change', renderList);
  ui.activeTab.addEventListener('click', () => switchView('active'));
  ui.trashTab.addEventListener('click', () => switchView('trash'));
  window.addEventListener('beforeunload', (event) => {
    if (!isDirty() && !state.saving) return;
    event.preventDefault();
    event.returnValue = '';
  });

  (async () => {
    try {
      const role = await StageCloud.getRole();
      if (!['owner', 'editor'].includes(role)) throw new StageCloud.CloudError('当前账号没有管理权限，请联系站主。',403);
      byId('owner-access-links').hidden = role !== 'owner';
      byId('download-backup').addEventListener('click', async () => { try { await StageCloud.downloadBackup(); } catch(error) { setStatus(error.message,'error'); } });
      await loadSchedule();
    } catch(error) { setStatus(error.message || '暂时无法验证管理权限。','error',true); syncControls(); }
  })();
})();
