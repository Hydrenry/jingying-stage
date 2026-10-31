/* 公开日历从共享排期数据库读取；管理入口位于 /admin。 */
(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  async function loadSchedule() {
    const result = await StageCloud.getPublicSchedule();
    if (!Array.isArray(result.performances)) throw new Error('Invalid schedule');
    return { ...result.metadata, ...result, actorName: result.actorName || result.metadata?.actorName || '王晶莹' };
  }
  let data;
  try { data = await loadSchedule(); }
  catch (_) { $('performances').textContent = '排期暂时未能载入，请刷新重试。'; return; }
  const monthNames = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const pad = (value) => String(value).padStart(2, '0');
  const shanghaiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const sortRecords = (items) => [...items].sort((a, b) => (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99')));
  let records = sortRecords(data.performances);
  const currentMonth = shanghaiToday.slice(0, 7);
  const initialMonth = records.some((item) => item.date.startsWith(currentMonth)) ? currentMonth :
    (records.find((item) => item.date >= shanghaiToday)?.date || records[records.length - 1]?.date || shanghaiToday).slice(0, 7);
  let [year, month] = initialMonth.split('-').map(Number);
  let selectedDate = '';
  let selectedPerformance = null;
  let city = '';
  let query = '';

  const dateKey = (day) => `${year}-${pad(month)}-${pad(day)}`;
  const dateObject = (value) => { const parts = value.split('-').map(Number); return new Date(parts[0], parts[1] - 1, parts[2], 12); };
  const dateLabel = (value) => { const date = dateObject(value); return `${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]}`; };
  const timeLabel = (item) => item.time ? `${item.time}（北京时间）` : '时间待补充';
  const locationLabel = (item) => [item.city, item.venue].filter(Boolean).join(' · ') || '地点待补充';
  const statusLabel = (item) => !item.date ? '待逐场核实' :
    (/取消|变更|待定/.test(item.status || '') ? item.status : (item.date < shanghaiToday ? '往期排期' : '演出排期'));
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function matchingRecords() {
    return records.filter((item) => (!city || (city === '__unknown__' ? !item.city : item.city === city)) && (!query || `${item.title} ${item.city} ${item.venue} ${item.role || ''}`.toLocaleLowerCase().includes(query)));
  }
  function renderCalendar(filtered) {
    $('month-label').textContent = `${year}年${month}月`;
    $('month-english').textContent = monthNames[month - 1];
    $('month-jump').value = `${year}-${pad(month)}`;
    $('calendar-days').setAttribute('aria-label', `${year}年${month}月，点击日期筛选场次`);
    const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
    const days = new Date(year, month, 0).getDate();
    const counts = new Map();
    filtered.forEach((item) => counts.set(item.date, (counts.get(item.date) || 0) + 1));
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < Math.ceil((firstWeekday + days) / 7) * 7; i++) {
      const day = i - firstWeekday + 1;
      if (day < 1 || day > days) {
        const blank = element('span', 'calendar-blank'); blank.setAttribute('aria-hidden', 'true'); fragment.append(blank); continue;
      }
      const date = dateKey(day);
      const count = counts.get(date) || 0;
      const button = element('button', `calendar-day${count ? ' has-performance' : ''}${date === selectedDate ? ' is-selected' : ''}${date === shanghaiToday ? ' is-today' : ''}`, String(day));
      button.type = 'button';
      button.dataset.date = date;
      button.setAttribute('aria-label', `${month}月${day}日，${count ? `${count}条演出排期` : '暂无排期'}`);
      button.setAttribute('aria-pressed', String(date === selectedDate));
      if (date === shanghaiToday) button.setAttribute('aria-current', 'date');
      if (count) { const dot = element('span', 'event-dot'); dot.setAttribute('aria-hidden', 'true'); button.append(dot); }
      button.addEventListener('click', () => { selectedDate = selectedDate === date ? '' : date; render(); $('calendar-days').querySelector(`[data-date="${date}"]`)?.focus({ preventScroll: true }); });
      fragment.append(button);
    }
    $('calendar-days').replaceChildren(fragment);
  }
  function renderList(filtered) {
    const prefix = `${year}-${pad(month)}`;
    const visible = filtered.filter((item) => selectedDate ? item.date === selectedDate : item.date.startsWith(prefix));
    const heading = selectedDate ? `${dateLabel(selectedDate)}的排期` : '本月排期';
    $('list-heading').replaceChildren(document.createTextNode(heading + ' '));
    const count = element('span', '', String(visible.length)); count.id = 'performance-count'; $('list-heading').append(count);
    $('clear-date').hidden = !selectedDate;
    const fragment = document.createDocumentFragment();
    if (!visible.length) {
      const empty = element('div', 'empty-state');
      empty.append(element('span', '', '✳'), element('h4', '', query || city ? '没有匹配的场次' : '这页日历，暂时留白'), element('p', '', query || city ? '试试其他关键词、城市，或切换月份。' : '试着切换月份，或查看整月排期。'));
      fragment.append(empty);
    }
    visible.forEach((item) => {
      const date = dateObject(item.date);
      const card = element('button', 'performance-card'); card.type = 'button'; card.dataset.id = item.id;
      card.setAttribute('aria-label', `查看${item.title}详情，${dateLabel(item.date)} ${timeLabel(item)}，${locationLabel(item)}`);
      const tile = element('span', 'date-tile'); tile.append(element('strong', '', String(date.getDate())), element('small', '', `${month}月 / ${weekdays[date.getDay()]}`));
      const content = element('span', 'performance-content');
      const bottom = element('span', 'performance-bottom'); bottom.append(element('span', 'performance-tag', statusLabel(item)), element('span', '', `${item.time || '时间待补充'} · ${item.role || '角色待补充'}`));
      content.append(element('span', 'performance-title', item.title), element('span', 'performance-meta', locationLabel(item)), bottom);
      const arrow = element('span', 'card-arrow', '↗'); arrow.setAttribute('aria-hidden', 'true');
      card.append(tile, content, arrow); card.addEventListener('click', () => openDetail(item)); fragment.append(card);
    });
    $('performances').replaceChildren(fragment);
  }
  function render() { const filtered = matchingRecords(); renderCalendar(filtered); renderList(filtered); }
  function openDetail(item) {
    selectedPerformance = item;
    $('detail-title').textContent = item.title;
    $('detail-dialog').querySelector('.detail-badge').textContent = statusLabel(item);
    const fields = [['日期', item.date ? `${item.date} ${weekdays[dateObject(item.date).getDay()]}` : item.dateText || '待逐场核实'], ['时间', timeLabel(item)], ['城市', item.city || '待补充'], ['剧场', item.venue || '待补充'], ['角色', item.role || '待补充']];
    const fragment = document.createDocumentFragment();
    fields.forEach(([label, value]) => {
      const row = element('div'); const description = element('dd', '', value);
      row.append(element('dt', '', label), description); fragment.append(row);
    });
    $('detail-fields').replaceChildren(fragment); $('detail-note').textContent = item.note || '';
    $('copy-status').textContent = ''; if (!$('detail-dialog').open) $('detail-dialog').showModal();
  }
  function changeMonth(offset) {
    const date = new Date(year, month - 1 + offset, 1); year = date.getFullYear(); month = date.getMonth() + 1; selectedDate = ''; render();
  }
  function updateDataControls() {
    const cityPlaceholder = element('option', '', '全部城市'); cityPlaceholder.value = '';
    $('city-filter').replaceChildren(cityPlaceholder);
    [...new Set(records.map((item) => item.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')).forEach((name) => { const option = element('option', '', name); option.value = name; $('city-filter').append(option); });
    if (records.some((item) => !item.city)) { const option = element('option', '', '地点待补充'); option.value = '__unknown__'; $('city-filter').append(option); }
    $('city-filter').value = city;
    if ($('city-filter').value !== city) city = '';
    const monthPlaceholder = element('option', '', '跳转到已收录月份'); monthPlaceholder.value = '';
    $('month-jump').replaceChildren(monthPlaceholder);
    [...new Set(records.map((item) => item.date.slice(0, 7)))].sort().forEach((key) => { const option = element('option', '', key.replace('-', '年') + '月'); option.value = key; $('month-jump').append(option); });
    $('coverage').textContent = records.length ? `已收录 ${records.length} 条排期 · ${records[0].date} 至 ${records[records.length - 1].date}` : '暂未添加演出排期';
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(data.lastUpdatedAt || '');
    const updated = new Date(data.lastUpdatedAt);
    $('updated-at').textContent = Number.isNaN(updated.getTime()) ? '排期持续更新中' : `最近更新 ${new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',dateStyle:'medium',...(dateOnly ? {} : {timeStyle:'short'})}).format(updated)}`;
  }
  $('month-jump').addEventListener('change', (event) => { if (!event.target.value) return; [year, month] = event.target.value.split('-').map(Number); selectedDate = ''; render(); });
  $('previous-month').addEventListener('click', () => changeMonth(-1));
  $('next-month').addEventListener('click', () => changeMonth(1));
  $('reset-month').addEventListener('click', () => { [year, month] = shanghaiToday.slice(0, 7).split('-').map(Number); selectedDate = ''; render(); });
  $('clear-date').addEventListener('click', () => { selectedDate = ''; render(); });
  $('search').addEventListener('input', (event) => { query = event.target.value.trim().toLocaleLowerCase(); render(); });
  $('city-filter').addEventListener('change', (event) => { city = event.target.value; render(); });
  function setView(list) { $('schedule-layout').classList.toggle('is-list-view', list); $('calendar-view').classList.toggle('is-active', !list); $('list-view').classList.toggle('is-active', list); $('calendar-view').setAttribute('aria-pressed', String(!list)); $('list-view').setAttribute('aria-pressed', String(list)); }
  $('calendar-view').addEventListener('click', () => setView(false)); $('list-view').addEventListener('click', () => setView(true));
  $('about-button').addEventListener('click', () => $('about-dialog').showModal());
  $('close-about').addEventListener('click', () => $('about-dialog').close());
  $('close-detail').addEventListener('click', () => $('detail-dialog').close());
  for (const id of ['about-dialog', 'detail-dialog']) $(id).addEventListener('click', (event) => { if (event.target !== $(id)) return; const rect = $(id).getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $(id).close(); });
  $('copy-performance').addEventListener('click', async () => {
    if (!selectedPerformance) return;
    const item = selectedPerformance;
    const text = `${data.actorName} · ${item.title}\n${item.date || item.dateText || '日期待核实'} ${timeLabel(item)}\n${locationLabel(item)}${item.role ? `\n角色：${item.role}` : ''}${item.note ? `\n备注：${item.note}` : ''}`;
    try { if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable'); await navigator.clipboard.writeText(text); $('copy-status').textContent = '已复制，可粘贴到备忘录。'; }
    catch (_) { $('copy-status').textContent = `浏览器未允许自动复制，请长按或选中下面的文字手动复制：\n\n${text}`; }
  });
  updateDataControls();
  render();
  let refreshing = false;
  async function refreshSchedule() {
    if (refreshing || document.hidden) return;
    refreshing = true;
    try {
      const next = await loadSchedule();
      if (next.revision === data.revision) return;
      data = next; records = sortRecords(data.performances); updateDataControls(); render();
      if ($('detail-dialog').open && selectedPerformance) {
        const latest = records.find((item) => item.id === selectedPerformance.id);
        if (latest) openDetail(latest); else { $('detail-dialog').close(); selectedPerformance = null; }
      }
    } catch (_) { /* 保留上次成功读取的排期，下一次自动重试。 */ }
    finally { refreshing = false; }
  }
  setInterval(refreshSchedule, 30000);
  window.addEventListener('focus', refreshSchedule);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSchedule(); });
})();
