const $ = (selector, root = document) => root.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const e = escapeHTML;
const number = n => new Intl.NumberFormat('zh-CN').format(n ?? 0);
const date = n => n ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(n) : '尚未使用';
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  key: '<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-4-4 3-3m-6 0 3-3"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3" fill="currentColor"/><circle cx="16" cy="17" r="3" fill="currentColor"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  logout: '<path d="M9 4H4v16h5m7-12 4 4-4 4M8 12h12"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  coins: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 4 16 4 16 0V6M4 12v6c0 4 16 4 16 0v-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>', shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  tag: '<path d="M4 12V4h8l8 8-8 8z"/><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.grid}</svg>`;
const flower = '<img src="/favicon.svg" alt="" class="flower">';
const state = { upstreamSort: { key: 'id', direction: 'asc' }, csrf: null, view: 'overview', data: null, quota: null, quotaError: '', filter: '', keyMatches: null, keySearchError: '', logs: 'jobs', jobQuery: '', jobStatus: 'all', filteredJobs: null, jobError: '', cdks: null, cdkQuery: '', cdkHit: null };
let jobSearchVersion = 0, jobSearchTimer, jobSearchComposing = false;
const jobParameterSources = new WeakMap();
let keySearchTimer, keySearchVersion = 0, cdkVersion = 0;
let liveEvents = null, liveRetryTimer = null, settingsDirty = false, snapshotVersion = 0;
const titles = { overview: '运行概览', keys: '访问密钥', cdks: '兑换码', usage: '用量记录', settings: '上游设置' };

function toast(message, bad = false) {
  const node = document.createElement('div'); node.className = `toast ${bad ? 'bad' : ''}`; node.textContent = message; $('#toasts').append(node); setTimeout(() => node.remove(), 5000);
}
async function api(path, options = {}) {
  const response = await fetch(`/admin/api${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && state.data && !path.includes('password')) { stopEvents(); state.data = null; await init(); } throw new Error(data.error || '请求失败'); }
  return data;
}
async function withButton(button, fn) {
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.classList.add('working'); }
  try { await fn(); } catch (err) { toast(err.message, true); }
  finally { if (button) { button.disabled = false; button.classList.remove('working'); } }
}
function copyWithSelection(text) {
  const field = document.createElement('textarea');
  field.value = text; field.readOnly = true;
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px';
  const focused = document.activeElement, selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  // A modal dialog makes the rest of the document inert, so keep the field inside it.
  const dialog = $('#dialog'); (dialog?.open ? dialog : document.body).append(field);
  try {
    field.focus({ preventScroll: true }); field.select(); field.setSelectionRange(0, field.value.length);
    return document.execCommand('copy');
  } finally {
    field.remove(); focused?.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}
async function copy(text, source) {
  if (typeof navigator.clipboard?.writeText === 'function') {
    try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); return; }
    catch { /* Try selection-based copying if clipboard access is denied. */ }
  }
  try { if (copyWithSelection(text)) { toast('已复制到剪贴板'); return; } }
  catch { /* Keep the visible text available for manual copying. */ }
  if (source) {
    const selection = document.getSelection(), range = document.createRange();
    range.selectNodeContents(source); selection?.removeAllRanges(); selection?.addRange(range);
  }
  throw new Error('浏览器未允许自动复制，已选中文本，请按 Ctrl+C / ⌘C 或长按复制');
}
function modal(title, content, subtitle = '') {
  closeJobParameters();
  const dialog = $('#dialog');
  dialog.innerHTML = `<div class="modal-head"><div><h2 id="dialog-title">${e(title)}</h2>${subtitle ? `<p class="muted">${e(subtitle)}</p>` : ''}</div><button class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></div>${content}`;
  if (!dialog.open) dialog.showModal();
}
function closeModal() { closeJobParameters(); $('#dialog').close(); $('#dialog').innerHTML = ''; }
function badge(status) {
  const names = { pending: ['等待处理', 'pink'], cancelled: ['已取消', 'muted'], completed: ['成功', 'green'], failed: ['失败', 'muted'], rejected: ['失败', 'muted'], running: ['处理中', 'pink'], resolved: ['已结算', 'green'] };
  const [name, color] = names[status] ?? ['未知', 'muted']; return `<span class="badge ${color}"><i></i>${name}</span>`;
}
const empty = (title, hint, action = '') => `<div class="empty"><span class="empty-icon">${icon('key')}</span><h3>${title}</h3>${hint ? `<p>${hint}</p>` : ""}${action}</div>`;

function login(initialized) {
  $('#app').innerHTML = `<main class="auth"><aside class="auth-art"><div class="brand">${flower}<span>Sakura <b>Relay</b></span></div><div class="art-copy"><h1>密钥与用量，<br>统一管理。</h1></div><div class="orb orb-one"></div><div class="orb orb-two"></div><div class="flower-art">✿</div></aside><section class="auth-form"><div class="auth-inner"><span class="auth-symbol">${flower}</span><h2>${initialized ? '登录' : '初始化管理员'}</h2><form id="auth-form" data-setup="${!initialized}">${initialized ? '' : '<label>初始化码<input name="code" autocomplete="off" required placeholder="填写初始化码"></label><p class="field-note">初始化码见服务端 setup-code.txt。</p>'}<label>管理员密码<input name="password" type="password" autocomplete="${initialized ? 'current-password' : 'new-password'}" required minlength="12" maxlength="256" placeholder="${initialized ? '输入你的密码' : '至少 12 个字符'}"></label>${initialized ? '' : '<label>确认密码<input name="confirm" type="password" autocomplete="new-password" required minlength="12" placeholder="再次输入密码"></label>'}<div class="form-error" role="alert"></div><button class="button primary full" type="submit">${initialized ? '进入控制台' : '创建管理员'}${icon('arrow')}</button></form></div></section></main>`;
}
function shell() {
  const title = titles[state.view], d = state.data;
  $('#app').innerHTML = `<div class="workspace"><aside class="sidebar"><a class="brand" href="#overview" aria-label="Sakura Relay 概览">${flower}<span>Sakura <b>Relay</b></span></a><nav aria-label="主导航">${[['overview','grid','运行概览'],['keys','key','访问密钥'],['cdks','tag','兑换码'],['usage','activity','用量记录'],['settings','settings','上游设置']].map(([id, symbol, text]) => `<a href="#${id}" aria-label="${text}" class="nav-item ${state.view === id ? 'active' : ''}" ${state.view === id ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${text}</span>${id === 'keys' ? '<small>'+d.keys.length+'</small>' : ''}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="connection-state"><i class="status-dot ${d.settings.configured && d.settings.enabled ? 'online' : ''}"></i><div>${d.settings.configured ? d.settings.enabled ? '中转已启用' : '中转已暂停' : '未配置上游'}</div></div><div class="admin-card"><div class="avatar">S</div><div>管理员</div><button class="icon-button" data-action="logout" aria-label="退出登录">${icon('logout')}</button></div></div></aside><main class="main"><div class="content"><section class="page-heading"><h1>${title}</h1>${state.view === 'keys' || state.view === 'overview' ? '<div class="heading-actions"><button class="button primary" data-action="create">'+icon('plus')+'创建密钥</button></div>' : ''}</section><div id="view"></div></div></main></div>`;
  renderView();
}
function quotaFor(id) { return state.quota?.upstreams.find(q => q.id === id); }
function remaining(q) { const u = q?.account?.usage; return u ? u.isNegative ? 0 : Math.max(0, Math.min(100, u.percent)) : null; }
const tierName = tier => tier === 'member' ? '会员' : '普通';
const staminaPct = units => (Math.round((units ?? 0) / 112000 * 1000) / 10).toFixed(1);
const staminaText = k => k.tier === 'member' ? staminaPct(k.stamina_balance-k.stamina_reserved)+'% / '+staminaPct(k.stamina_capacity)+'%' : '0.0%';
const expiresText = value => value === null ? '永久有效' : new Date(value).toLocaleString('zh-CN', { hour12: false });
const expired = key => key.expires_at !== null && key.expires_at <= Date.now();
const keyStatus = key => !key.enabled ? '已停用' : expired(key) ? '已过期' : '已启用';
function keyForm(id) {
  const k = state.data.keys.find(row => row.id === Number(id));
  const dateValue = k?.expires_at ? new Date(k.expires_at - new Date(k.expires_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  modal(k ? '编辑访问密钥' : '创建访问密钥', `<form id="key-form" data-id="${k?.id ?? ''}">
    <label>名称<input name="name" value="${e(k?.name ?? '')}" maxlength="64" autofocus></label>
    <label>密钥等级<select name="tier" aria-label="密钥等级"><option value="standard" ${k?.tier === 'standard' ? 'selected' : ''}>普通 · 按点数使用</option><option value="member" ${!k || k.tier === 'member' ? 'selected' : ''}>会员 · Opus 计费权益</option></select></label>
    <div data-member-fields><label>体力上限（%）<input name="staminaPercent" type="number" min="0" max="100" step="1" value="${k?.tier === 'member' ? k.stamina_capacity / 1120 : 25}"></label></div>
    ${k ? '' : '<label>初始点数（Anlas）<input name="points" type="number" min="0" max="1000000000" step="1" value="0" required></label>'}
    <label>有效期<select name="expiryMode" aria-label="有效期">${k ? '<option value="keep" selected>保持当前有效期</option>' : ''}<option value="never">永久有效</option><option value="days" ${k ? '' : 'selected'}>${k ? '按天数续期' : '按天数设置'}</option><option value="date">指定到期时间</option></select></label>
    ${k ? `<p class="field-note">当前：${e(expiresText(k.expires_at))}</p>` : ''}
    <label data-expiry-days>有效天数<input name="validDays" type="number" min="1" max="36500" step="1" value="30"></label>
    <label data-expiry-date>到期时间（本地时区）<input name="expiresAt" type="datetime-local" value="${e(dateValue)}"></label>
    <div class="form-error" role="alert"></div><div class="modal-actions"><button class="button subtle" type="button" data-action="close">取消</button><button class="button primary" type="submit">${k ? '保存修改' : '创建密钥'}</button></div></form>`);
  syncKeyForm();
}
function syncKeyForm() {
  const f = $('#key-form'); if (!f) return;
  const member = f.elements.tier.value === 'member', mode = f.elements.expiryMode.value;
  const memberFields = $('[data-member-fields]', f);
  if (memberFields) { memberFields.hidden = !member; f.elements.staminaPercent.required = member; f.elements.staminaPercent.disabled = !member; }
  $('[data-expiry-days]', f).hidden = mode !== 'days'; f.elements.validDays.required = mode === 'days';
  $('[data-expiry-date]', f).hidden = mode !== 'date'; f.elements.expiresAt.required = mode === 'date';
}
function upstreamBadge(row) {
  const [text, color] = !row.enabled ? ['已停用', 'muted'] : row.busy ? ['生成中', 'pink'] : row.cooldownUntil > Date.now() ? ['冷却中', 'amber'] : ['已启用', 'green'];
  return '<span class="badge '+color+'"><i></i>'+text+'</span>';
}
function upstreamSortValue(row, key) {
  const q = quotaFor(row.id);
  if (key === 'expires') return q?.ok && q.account.expiresAt ? q.account.expiresAt : null;
  if (key === 'points') return q?.ok ? q.account.relay.balance : null;
  if (key === 'stamina') return q?.ok ? remaining(q) : null;
  return row[key] ?? null;
}
function sortedUpstreams() {
  const { key, direction } = state.upstreamSort;
  return [...state.data.upstreams].sort((a, b) => {
    if (!!a.enabled !== !!b.enabled) return a.enabled ? -1 : 1;
    const x = upstreamSortValue(a, key), y = upstreamSortValue(b, key);
    if (x === null || y === null) return x === y ? a.id - b.id : x === null ? 1 : -1;
    const comparison = typeof x === 'string' ? x.localeCompare(y, 'zh-CN', { numeric: true }) : x - y;
    return (direction === 'asc' ? comparison : -comparison) || a.id - b.id;
  });
}
function upstreamTable() {
  const rows = sortedUpstreams();
  if (!rows.length) return empty('暂无上游', '', '<button class="button subtle" data-action="add-upstream">添加上游</button>');
  const heading = (key, label) => {
    const active = state.upstreamSort.key === key, ascending = state.upstreamSort.direction === 'asc';
    return `<th aria-sort="${active ? ascending ? 'ascending' : 'descending' : 'none'}"><button class="sort-button" data-action="sort-upstreams" data-sort="${key}">${label}<span aria-hidden="true">${active ? ascending ? '↑' : '↓' : '↕'}</span></button></th>`;
  };
  return `<div class="table-scroll"><table class="upstream-table"><thead><tr><th aria-sort="${state.upstreamSort.key === 'id' ? 'other' : 'none'}"><button class="sort-button" data-action="sort-upstreams" data-sort="id" title="恢复默认排序">上游名称</button></th><th>状态 / 套餐</th>${heading('priority', '优先级')}${heading('expires', '过期时间')}${heading('points', '点数 · Anlas')}${heading('stamina', '体力 · NAI5')}<th>排队</th><th>备注</th><th>操作</th></tr></thead><tbody>${rows.map((row, index) => {
    const groupStart = index === 0 || !!rows[index - 1].enabled !== !!row.enabled;
    const group = groupStart ? `<tr class="upstream-group${row.enabled ? '' : ' upstream-group-disabled'}"><th colspan="9" scope="rowgroup">${row.enabled ? '已启用' : '已停用'}<span class="count">${rows.filter(item => !!item.enabled === !!row.enabled).length}</span></th></tr>` : '';
    const q = quotaFor(row.id), pct = q?.ok ? remaining(q) : null;
    const error = row.error || (q && !q.ok ? q.error : '');
    return `${group}<tr><td><strong>${e(row.name)}</strong><code class="cell-note">•••• ${e(row.suffix)}</code></td><td>${upstreamBadge(row)}<span class="cell-note">${q?.ok ? e(({0:'无订阅',1:'Tablet',2:'Scroll',3:'Opus'})[q.account.tier] ?? '其他套餐') : '套餐待查询'}</span>${error ? `<span class="cell-note">${e(error)}</span>` : ''}</td><td>${number(row.priority ?? 0)}</td><td class="upstream-expiry">${q?.ok && q.account.expiresAt ? e(expiresText(q.account.expiresAt * 1000)) : '—'}</td><td><strong class="point-value">${q?.ok ? number(q.account.relay.balance) : '—'}</strong></td><td><div class="upstream-stamina"><span>${pct === null ? '—' : pct.toFixed(1) + '%'}</span><div class="progress-track"><div style="width:${pct ?? 0}%"></div></div></div></td><td>${number(row.queued ?? 0)}</td><td class="upstream-note">${e(row.note || '—')}</td><td><div class="upstream-actions"><button class="button small subtle" data-action="edit-upstream" data-id="${row.id}">编辑</button><button class="button small text-button" data-action="toggle-upstream" data-id="${row.id}">${row.enabled ? '停用' : '启用'}</button></div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function editUpstream(id) {
  const row = state.data.upstreams.find(u => u.id === Number(id));
  modal(row ? '编辑上游' : '添加上游', `<form id="upstream-form" data-id="${row?.id ?? ''}"><label>上游名称<input name="name" value="${e(row?.name ?? '')}" maxlength="64" placeholder="填写账户邮箱或名称" autofocus></label><label>调度优先级<input name="priority" type="number" min="0" max="999999" step="1" value="${row?.priority ?? 0}" required></label><label>备注（可选）<textarea name="note" rows="3" maxlength="1000" placeholder="填写账户备注">${e(row?.note ?? '')}</textarea></label><label>NovelAI 官方 Key<input name="token" type="password" autocomplete="new-password" maxlength="4096" placeholder="${row ? '留空保留已保存的 Key · 尾号 ' + e(row.suffix) : 'pst-…'}" ${row ? '' : 'required'}></label><div class="toggle-row"><div><strong>启用上游</strong></div><label class="switch"><input name="enabled" type="checkbox" ${!row || row.enabled ? 'checked' : ''} aria-label="启用上游"><span></span></label></div><div class="form-error" role="alert"></div><div class="modal-actions">${row ? '<button class="button danger" type="button" data-action="remove-upstream" data-id="'+row.id+'">移除</button>' : ''}<button class="button subtle" type="button" data-action="close">取消</button><button class="button primary" type="submit">${row ? '保存修改' : '添加上游'}</button></div></form>`);
}
function usageChart(days, metric, title, unit) {
  const max = Math.max(1, ...days.map(day => day[metric] ?? 0));
  const total = days.reduce((sum, day) => sum + (day[metric] ?? 0), 0);
  return `<section class="panel activity-panel usage-${metric}"><div class="panel-title"><h2>${title}</h2></div><div class="chart" aria-label="${title}柱状图">${days.map(day => {
    const value = day[metric] ?? 0;
    return `<div class="chart-column" title="${day.label}：${number(value)} ${unit}"><span class="chart-number">${number(value)}</span><div class="bar-space"><div class="bar ${value ? '' : 'zero'}" style="height:${value ? Math.max(4, value / max * 100) : 2}%"></div></div><span class="chart-date">${day.label}</span></div>`;
  }).join('')}</div><div class="chart-caption"><span>7 天合计</span><b>${number(total)} <small>${unit}</small></b></div></section>`;
}
function usageComparison(days) {
  const series = [{ metric: 'spent', label: '下游用量', style: 'downstream' }, { metric: 'upstreamSpent', label: '上游用量', style: 'upstream' }];
  const max = Math.max(1, ...days.flatMap(day => series.map(s => day[s.metric] ?? 0)));
  return `<section class="panel activity-panel usage-comparison"><div class="panel-title"><h2>最近 7 天 Anlas 用量</h2></div><div class="comparison-legend">${series.map(s => `<span><i class="${s.style}"></i>${s.label}</span>`).join('')}</div><div class="comparison-chart" role="img" aria-label="最近 7 天下游与上游 Anlas 用量对比柱状图">${days.map(day => `<div class="comparison-day"><div class="comparison-bars">${series.map(s => {
    const value = day[s.metric] ?? 0;
    return `<div class="comparison-column ${s.style}" title="${day.label} ${s.label}：${number(value)} Anlas"><span class="comparison-value">${number(value)}</span><div class="comparison-bar ${value ? '' : 'zero'}" style="height:${value ? Math.max(4, value / max * 128) : 2}px"></div></div>`;
  }).join('')}</div><span class="chart-date">${day.label}</span></div>`).join('')}</div><div class="chart-caption comparison-totals"><span>7 天合计</span>${series.map(s => `<span class="${s.style}">${s.label}<b>${number(days.reduce((sum, day) => sum + (day[s.metric] ?? 0), 0))} <small>Anlas</small></b></span>`).join('')}</div></section>`;
}
function quotaTotals(data, quota, now = Date.now()) {
  const keys = data.keys.filter(key => key.enabled && (key.expires_at === null || key.expires_at > now));
  const totals = {
    stamina: { available: 0, issued: keys.reduce((sum, key) => sum + (key.tier === 'member' ? Math.max(0, key.stamina_balance - key.stamina_reserved) : 0), 0) / 1120 },
    anlas: { available: 0, issued: keys.reduce((sum, key) => sum + (key.tier === 'member' ? Math.max(0, key.balance - key.reserved) : 0), 0) },
  };
  for (const row of data.upstreams.filter(row => row.enabled)) {
    const result = quota?.upstreams.find(item => item.id === row.id);
    if (!result?.ok) { totals.stamina.available = null; totals.anlas.available = null; continue; }
    const account = result.account;
    if (totals.anlas.available !== null) totals.anlas.available += account.relay.available;
    const active = [1, 2, 3, 4].includes(account.accountType ?? 0) || (account.expiresAt !== undefined ? account.expiresAt > now / 1000 : account.active);
    if (account.tier !== 3 || !active) continue;
    const usage = account.usage;
    if (!Number.isFinite(usage?.percent) || typeof usage.isNegative !== 'boolean') { totals.stamina.available = null; continue; }
    if (totals.stamina.available !== null) totals.stamina.available += usage.isNegative ? 0 : Math.max(0, Math.min(100, usage.percent));
  }
  return totals;
}
function quotaComparison() {
  const totals = quotaTotals(state.data, state.quota);
  return `<div class="quota-comparison-grid">${[['stamina', 'V5 体力'], ['anlas', 'Anlas']].map(([metric, title]) => {
    const { available, issued } = totals[metric], difference = available === null ? null : available - issued;
    const format = value => value === null ? '—' : metric === 'stamina' ? value.toFixed(1) + '%' : number(value);
    return `<section class="panel quota-comparison"><div class="panel-title"><h2>${title}</h2><span class="quota-difference ${difference < 0 ? 'deficit' : ''}">差额 <b>${format(difference)}</b></span></div><div class="quota-comparison-values">${[['上游剩余', available, 'available'], ['下游剩余', issued, 'issued']].map(([label, value, kind]) => `<div class="quota-comparison-row ${kind}"><span>${label}</span><strong>${format(value)}</strong></div>`).join('')}</div></section>`;
  }).join('')}</div>`;
}
function overview() {
  const d = state.data;
  const cards = [['访问密钥', number(d.keys.filter(k => k.enabled && !expired(k)).length), 'key'], ['上游密钥', number(d.upstreams.filter(u => u.enabled).length), 'shield'], ['今日活跃', number(d.stats.activeToday), 'activity'], ['正在生成', number(d.stats.generating), 'clock']];
  const now = Date.now();
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(now - (6 - i) * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    return { ...d.trend.find(item => item.day === day), label: Number(day.slice(5, 7)) + '/' + Number(day.slice(8, 10)) };
  });
  return `${!d.settings.configured ? `<div class="onboarding"><span class="onboarding-icon">${icon('settings')}</span><div><strong>尚未配置上游</strong></div><a href="#settings" class="button text-button">添加上游 ${icon('arrow')}</a></div>` : ''}<div class="stats-grid">${cards.map(([name,value,symbol]) => `<article class="stat-card"><div>${name}<span>${icon(symbol)}</span></div><strong>${value}</strong></article>`).join('')}</div>${quotaComparison()}<div class="usage-grid">${usageComparison(days)}${usageChart(days, "requests", "最近 7 天请求次数", "次")}</div>`;
}
function keyTable(keys) {
  if (state.view === 'keys' && state.filter.trim()) {
    if (state.keyMatches === null) return `<div role="${state.keySearchError ? 'alert' : 'status'}">${empty(state.keySearchError ? '搜索失败，请重试' : '正在搜索…', '')}</div>`;
    if (!keys.length) return empty('没有匹配的密钥', '');
  }
  if (!keys.length) return empty('暂无访问密钥', '', '<button class="button subtle" data-action="create">创建密钥</button>');
  return '<div class="table-scroll"><table><thead><tr><th>密钥 / 等级</th><th>状态 / 到期</th><th>可用点数</th><th>V5 体力</th><th class="right">管理</th></tr></thead><tbody>' + keys.map(k =>
    '<tr><td><div class="key-cell"><span class="key-avatar">'+icon('key')+'</span><div><strong>'+e(k.name)+'</strong><code>'+e(k.prefix)+'</code><small class="cell-note">'+tierName(k.tier)+'</small></div></div></td>'+
    '<td><span class="badge '+(k.enabled && !expired(k) ? 'green' : 'muted')+'"><i></i>'+keyStatus(k)+'</span><small class="cell-note">'+e(expiresText(k.expires_at))+'</small></td>'+
    '<td><span class="point-value">'+number(k.balance-k.reserved)+'</span><small class="cell-note">'+(k.reserved ? '预留 '+number(k.reserved)+' Anlas' : 'Anlas')+'</small></td>'+
    '<td>'+staminaText(k)+'<small class="cell-note">'+(k.tier === 'member' ? Math.floor((k.stamina_balance-k.stamina_reserved)/100)+' / '+(k.stamina_capacity/100)+' 张' : '按点数使用')+'</small></td>'+
    '<td class="right"><button class="button small subtle" data-action="points" data-id="'+k.id+'">调整点数</button><button class="button small subtle" data-action="edit-key" data-id="'+k.id+'">编辑</button><button class="button small subtle" data-action="key-detail" data-id="'+k.id+'">查看密钥</button><button class="button small danger" data-action="remove-key" data-id="'+k.id+'">删除</button></td></tr>'
  ).join('')+'</tbody></table></div>';
}
function keysView() { return `<div class="panel"><div class="panel-title"><div><h2>全部密钥 <span class="count">${state.data.keys.length}</span></h2></div><label class="search">${icon('search')}<input id="key-search" type="search" placeholder="搜索名称或密钥" value="${e(state.filter)}" aria-label="搜索密钥"></label></div><div id="key-table">${keyTable(filteredKeys())}</div></div>`; }
function filteredKeys() {
  if (!state.filter.trim()) return state.data.keys;
  return state.data.keys.filter(k => state.keyMatches?.includes(k.id));
}
async function searchKeys() {
  const query = state.filter.trim(), version = ++keySearchVersion;
  if (!query) { state.keyMatches = null; state.keySearchError = ''; return; }
  try {
    const { ids } = await api('/keys/search', { method: 'POST', body: { query } });
    if (version !== keySearchVersion || query !== state.filter.trim()) return;
    state.keyMatches = ids; state.keySearchError = '';
    const table = $('#key-table'); if (table) table.innerHTML = keyTable(filteredKeys());
  } catch (error) {
    if (version !== keySearchVersion || query !== state.filter.trim()) return;
    state.keySearchError = error.message;
    const table = $('#key-table'); if (table) table.innerHTML = keyTable(filteredKeys());
    toast(error.message, true);
  }
}
function visibleJobs() { return state.filteredJobs ?? []; }
function jobTable() {
  if (state.filteredJobs === null) return empty(state.jobError || '加载中…', '');
  const rows = visibleJobs();
  return rows.length ? `<div class="table-scroll"><table class="request-table"><colgroup><col class="request-col-time"><col class="request-col-key"><col class="request-col-upstream"><col class="request-col-model"><col class="request-col-status"><col class="request-col-anlas"><col class="request-col-actions"></colgroup><thead><tr><th>请求 / 时间</th><th>Key</th><th>上游</th><th>模型 / 功能</th><th>状态</th><th>Anlas</th><th></th></tr></thead><tbody>${rows.map(j => `<tr data-status="${e(j.status)}"><td><code class="job-id">${e(j.id.slice(0,10))}</code><span class="request-line">${date(j.created_at)}</span></td><td><span class="request-key-name">${e(j.key_name ?? '未识别密钥')}</span><code class="request-line">${e(j.key_prefix ?? '—')}</code></td><td>${e(j.upstream_name || '未选择上游')}</td><td><span class="model-name">${e(j.model || '—')}</span><span class="request-line">${e(j.endpoint.replace('/ai/', ''))}</span></td><td>${badge(j.status)}${['failed', 'cancelled'].includes(j.status) ? `<span class="request-line request-reason">${e((j.note || '').slice(0, 80))}${j.note?.length > 80 ? '…' : ''}</span>` : ''}</td><td><strong>${j.charged === null ? '—' : number(j.charged)}</strong></td><td><button class="button small subtle" data-action="job" data-id="${e(j.id)}">详情</button></td></tr>`).join('')}</tbody></table></div>` : empty('没有匹配的请求记录', '');
}
function updateJobSearch(value, composing = false) {
  clearTimeout(jobSearchTimer); jobSearchVersion++; jobSearchComposing = composing;
  state.jobQuery = value; state.filteredJobs = null; state.jobError = '';
  const table = $('#request-records'); if (table) table.innerHTML = jobTable();
  if (!composing) jobSearchTimer = setTimeout(loadFilteredJobs, 200);
}
async function loadFilteredJobs() {
  clearTimeout(jobSearchTimer);
  const version = ++jobSearchVersion, query = state.jobQuery.trim(), status = state.jobStatus;
  if (!state.data || jobSearchComposing) return;
  try {
    const result = !query && status === 'all' ? { jobs: state.data.jobs } : await api('/jobs/search', { method: 'POST', body: { query, status } });
    if (version !== jobSearchVersion || query !== state.jobQuery.trim() || status !== state.jobStatus || !state.data) return;
    state.filteredJobs = result.jobs; state.jobError = '';
  } catch (error) {
    if (version !== jobSearchVersion || query !== state.jobQuery.trim() || status !== state.jobStatus || !state.data) return;
    state.filteredJobs = null; state.jobError = error.message;
  }
  const table = $('#request-records');
  if (table) {
    const scroll = $('.table-scroll', table), position = scroll ? [scroll.scrollLeft, scroll.scrollTop] : null;
    table.innerHTML = jobTable();
    const next = $('.table-scroll', table); if (next && position) [next.scrollLeft, next.scrollTop] = position;
  }
}
function usageView() {
  const d = state.data;
  const filter = `<div class="request-filters"><div class="tabs" role="group" aria-label="请求状态">${[['all', '全部'], ['failed', '失败']].map(([status, label]) => `<button data-action="job-status" data-status="${status}" class="${state.jobStatus === status ? 'selected' : ''}" aria-pressed="${state.jobStatus === status}">${label}</button>`).join('')}</div><label class="search job-search">${icon('search')}<input id="job-key-search" type="search" placeholder="搜索 Key" aria-label="搜索 Key" value="${e(state.jobQuery)}" maxlength="256" autocomplete="off" spellcheck="false"></label></div>`;
  return `<div class="panel${state.logs === 'jobs' ? ' request-log-panel' : ''}"><div class="panel-title request-log-heading"><div class="tabs"><button data-action="logs" data-tab="jobs" class="${state.logs === 'jobs' ? 'selected' : ''}">请求记录</button><button data-action="logs" data-tab="ledger" class="${state.logs === 'ledger' ? 'selected' : ''}">Anlas 流水</button></div>${state.logs === 'jobs' ? filter : ''}</div>${state.logs === 'jobs' ? `<div id="request-records">${jobTable()}</div>` : (d.ledger.length ? `<div class="table-scroll"><table><thead><tr><th>时间</th><th>访问密钥</th><th>类型</th><th>Anlas 变化</th><th>备注</th></tr></thead><tbody>${d.ledger.map(l => `<tr><td class="date-cell">${date(l.created_at)}</td><td>${e(l.key_name)}</td><td>${({ grant: '创建分配', adjust: '管理调整', usage: '用量结算' })[l.kind]}</td><td><strong class="${l.delta > 0 ? 'positive' : ''}">${l.delta > 0 ? '+' : ''}${number(l.delta)}</strong></td><td>${e(l.note)}</td></tr>`).join('')}</tbody></table></div>` : empty('暂无 Anlas 流水', ''))}</div>`;
}
function settingsView() {
  const s = state.data.settings, rows = state.data.upstreams;
  return `<section class="pool-section"><div class="pool-heading"><h2>上游账户 <span class="count">${rows.length}</span></h2><button class="button primary" data-action="add-upstream">${icon('plus')}添加上游</button></div><div id="upstream-list" class="panel upstream-list">${upstreamTable()}</div></section><form class="panel settings-form" id="settings-form"><div class="panel-title"><h2>访问设置</h2><button class="button small subtle" type="button" data-action="password">修改密码</button></div><div class="access-fields"><div><label>允许的来源<textarea name="origins" rows="3" placeholder="* 或 https://example.com">${e(s.origins.join('\n'))}</textarea></label></div><div><label id="relay-address-label">中转地址</label><div class="address-field" aria-labelledby="relay-address-label"><code>${e(state.data.relayUrl)}</code><button class="icon-button" type="button" data-action="copy-url" aria-label="复制中转地址">${icon('copy')}</button></div><div class="toggle-row"><strong>开放中转</strong><label class="switch"><input name="enabled" type="checkbox" ${s.enabled ? 'checked' : ''} aria-label="开放中转"><span></span></label></div></div></div><div class="form-footer"><button class="button primary" type="submit">保存设置</button></div></form>`;
}
const cdkSpec = product => `${product.tier === 'member' ? '会员' : '普通'} · ${product.validDays} 天 · ${number(product.points)} 点${product.tier === 'member' ? product.staminaPercent === 0 ? ' · 无 V5 体力' : ` · 体力 ${product.staminaPercent}%` : ''}`;
function cdksView() {
  if (!state.cdks) return '<div class="panel"><div class="empty"><h3>正在读取库存</h3></div></div>';
  if (state.cdks.error) return `<div class="panel"><div class="empty"><h3>兑换码加载失败</h3><p>${e(state.cdks.error)}</p></div></div>`;
  const url = state.data.redeemUrl || `${state.data.relayUrl.replace(/\/$/, '')}/redeem`;
  const cards = state.cdks.products.map(product => `<article class="cdk-card"><h3>${e(product.name)}</h3><p class="field-note">${e(cdkSpec(product))}</p><div class="cdk-stock"><span>未使用<b>${number(product.unused)}</b></span><span>已兑换<b>${number(product.redeemed)}</b></span>${product.voided ? `<span>已作废<b>${number(product.voided)}</b></span>` : ''}</div><div class="cdk-card-actions"><button class="button small primary" data-action="mint-cdks" data-id="${e(product.id)}">生成库存</button><button class="button small subtle" data-action="export-cdks" data-id="${e(product.id)}">复制未使用</button></div></article>`).join('');
  const rows = state.cdks.redemptions.length ? `<div class="table-scroll"><table><thead><tr><th>兑换时间</th><th>商品</th><th>兑换码</th><th>密钥</th></tr></thead><tbody>${state.cdks.redemptions.map(row => `<tr><td class="date-cell">${date(row.redeemed_at)}</td><td>${e(state.cdks.products.find(product => product.id === row.product_id)?.name || row.product_id)}</td><td><code>${e(row.prefix)}…</code></td><td>${e(row.key_name || '已删除')}<small class="cell-note">${e(row.key_prefix || '')}</small></td></tr>`).join('')}</tbody></table></div>` : empty('还没有人兑换', '');
  return `<div class="panel cdk-intro"><div class="panel-title"><div><h2>买家兑换页</h2></div></div><div class="cdk-address"><label id="redeem-address-label">兑换地址</label><div class="address-field" aria-labelledby="redeem-address-label"><code id="redeem-url">${e(url)}</code><button class="icon-button" type="button" data-action="copy-redeem-url" aria-label="复制兑换地址">${icon('copy')}</button></div></div></div><div class="cdk-grid">${cards}</div><section class="panel cdk-recent"><div class="panel-title"><div><h2>兑换记录</h2></div><form id="cdk-search-form" class="cdk-search"><label class="search">${icon('search')}<input name="code" type="search" placeholder="完整兑换码" value="${e(state.cdkQuery)}" aria-label="搜索兑换码" maxlength="40" autocomplete="off" spellcheck="false"></label><button class="button small subtle" type="submit">查找</button><div class="form-error" role="alert"></div></form></div><div id="cdk-search-result">${cdkHitView()}</div>${rows}</section>`;
}
function cdkHitView() {
  const hit = state.cdkHit; if (!hit) return '';
  const name = state.cdks?.products.find(product => product.id === hit.productId)?.name || hit.productId;
  const voided = hit.voidedAt ? `<p class="muted">已于 ${date(hit.voidedAt)} 作废${hit.voidReason ? ' · ' + e(hit.voidReason) : ''}</p>` : '';
  if (hit.status === 'voided') return `<div class="cdk-hit"><strong>${e(name)}</strong>${voided}</div>`;
  if (hit.status === 'unused') return `<div class="cdk-hit"><strong>${e(name)}</strong><button class="button small danger" type="button" data-action="void-cdk">作废兑换码</button></div>`;
  if (hit.status === 'deleted') return `<div class="cdk-hit"><strong>${e(name)}</strong><p class="muted">${e(hit.keyName || '对应密钥')}已于 ${date(hit.redeemedAt)} 兑换，密钥已删除。</p></div>`;
  return `<div class="cdk-hit"><strong>${e(name)}</strong><p class="muted">${date(hit.redeemedAt)} 兑换 · ${e(hit.keyName)} · ${e(hit.keyPrefix)}${hit.keyEnabled ? '' : ' · 已停用'}</p>${voided}<div class="cdk-card-actions"><button class="button small subtle" type="button" data-action="reveal-cdk-key" data-id="${hit.keyId}">查看密钥</button>${hit.keyEnabled || !hit.voidedAt ? '<button class="button small danger" type="button" data-action="void-cdk">作废并停用密钥</button>' : ''}</div></div>`;
}
function showCodes(title, codes) {
  modal(`${title}（${codes.length} 枚）`, `<textarea id="cdk-codes" readonly rows="12">${e(codes.join('\n'))}</textarea><div class="modal-actions"><button class="button subtle" type="button" data-action="close">关闭</button><button class="button primary" type="button" data-action="copy-cdks">${icon('copy')}复制全部</button></div>`);
}
function mintCdks(id) {
  const product = state.cdks?.products.find(item => item.id === id); if (!product) return;
  modal('生成兑换码', `<form id="cdk-form" data-product="${e(product.id)}"><p class="muted">${e(product.name)}</p><p class="field-note">${e(cdkSpec(product))}</p><label>生成数量<input name="count" type="number" min="1" max="200" step="1" value="20" required autofocus></label><div class="form-error" role="alert"></div><div class="modal-actions"><button class="button subtle" type="button" data-action="close">取消</button><button class="button primary" type="submit">生成</button></div></form>`);
}
async function loadCdks() {
  const version = ++cdkVersion;
  try {
    const data = await api('/cdks');
    if (version !== cdkVersion || state.view !== 'cdks') return;
    state.cdks = data;
  } catch (error) {
    if (version !== cdkVersion || state.view !== 'cdks') return;
    state.cdks = { error: error.message, products: [], redemptions: [] };
  }
  const view = $('#view'); if (view && state.view === 'cdks') view.innerHTML = cdksView();
}
function renderView() {
  $('#view').innerHTML = ({ overview, keys: keysView, cdks: cdksView, usage: usageView, settings: settingsView })[state.view]();
  if (state.view === 'keys' && state.filter.trim()) void searchKeys();
  if (state.view === 'cdks' && !state.cdks) void loadCdks();
  if (state.view === 'usage' && state.logs === 'jobs') void loadFilteredJobs();
}
function stopEvents() { clearTimeout(jobSearchTimer); clearTimeout(liveRetryTimer); liveRetryTimer = null; liveEvents?.close(); liveEvents = null; snapshotVersion++; jobSearchVersion++; }
function updateQuota(data) {
  if (state.quota && state.quota.fetchedAt > data.fetchedAt) return;
  state.quota = data; state.quotaError = '';
  const comparison = $('.quota-comparison-grid'); if (comparison) comparison.outerHTML = quotaComparison();
  const cards = $('#upstream-list'); if (cards) cards.innerHTML = upstreamTable();
}
function mergeSnapshotPatch(previous, patch) {
  const next = { ...previous, ...patch.values };
  for (const [field, change] of Object.entries(patch.collections)) {
    const rows = new Map(previous[field].map(row => [row.id, row]));
    for (const id of change.remove) rows.delete(id);
    for (const row of change.upsert) rows.set(row.id, row);
    next[field] = change.order ? change.order.map(id => rows.get(id)) : [...rows.values()];
  }
  return next;
}
function applySnapshot(data) {
  const previous = state.data; state.data = data; state.cdks = data.cdks; snapshotVersion++; cdkVersion++;
  if (!previous) { settingsDirty = false; shell(); return; }
  if (state.view === 'usage' && state.logs === 'jobs' && (previous.jobs !== data.jobs || previous.keys !== data.keys)) void loadFilteredJobs();
  const count = $('.nav-item[href="#keys"] small'); if (count) count.textContent = data.keys.length;
  const connection = $('.connection-state');
  if (connection) {
    $('i', connection).classList.toggle('online', data.settings.configured && data.settings.enabled);
    $('div', connection).textContent = data.settings.configured ? data.settings.enabled ? '中转已启用' : '中转已暂停' : '未配置上游';
  }
  const view = $('#view'); if (!view) return;
  const focused = document.activeElement, selection = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
  const scrolls = Array.from(view.querySelectorAll('.table-scroll'), node => [node.scrollLeft, node.scrollTop]);
  if (state.view === 'keys') {
    const count = $('.count', view); if (count) count.textContent = data.keys.length;
    $('#key-table').innerHTML = keyTable(filteredKeys());
    // Balance and job updates do not invalidate a hidden-token search.
    const identity = keys => JSON.stringify(keys.map(key => [key.id, key.name, key.prefix]));
    if (state.filter.trim() && identity(previous.keys) !== identity(data.keys)) void searchKeys();
  } else {
    const preserved = state.view === 'settings' && settingsDirty ? $('#settings-form') : state.view === 'cdks' ? $('#cdk-search-form') : null;
    const keyFilter = state.view === 'usage' ? $('#job-key-search') : null;
    view.innerHTML = ({ overview, cdks: cdksView, usage: usageView, settings: settingsView })[state.view]();
    if (preserved) $('#'+preserved.id).replaceWith(preserved);
    if (keyFilter) {
      const next = $('#job-key-search');
      if (next) next.replaceWith(keyFilter);
    }
  }
  if (focused && view.contains(focused)) { focused.focus({ preventScroll: true }); if (selection) focused.setSelectionRange(...selection); }
  view.querySelectorAll('.table-scroll').forEach((node, index) => { if (scrolls[index]) [node.scrollLeft, node.scrollTop] = scrolls[index]; });
}
function startEvents() {
  if (liveEvents || !state.data || !state.csrf) return;
  const source = liveEvents = new EventSource('/admin/api/events?delta=1');
  // Keep the stream baseline separate from one-off HTTP refreshes.
  let baseline = null;
  source.addEventListener('snapshot', event => { if (liveEvents === source) applySnapshot(baseline = JSON.parse(event.data)); });
  source.addEventListener('patch', event => {
    if (liveEvents === source && baseline) applySnapshot(baseline = mergeSnapshotPatch(baseline, JSON.parse(event.data)));
  });
  source.addEventListener('quota', event => { if (liveEvents === source) updateQuota(JSON.parse(event.data)); });
  source.addEventListener('session-expired', () => {
    if (liveEvents !== source) return;
    stopEvents(); state.data = null; state.csrf = null; state.quota = null; closeModal();
    void init().catch(error => toast(error.message, true));
  });
  source.onerror = () => {
    // EventSource reconnects automatically; status also detects expiry while offline.
    if (liveEvents !== source) return;
    if (source.readyState === EventSource.CLOSED && !liveRetryTimer) {
      liveRetryTimer = setTimeout(() => {
        liveRetryTimer = null;
        if (liveEvents !== source) return;
        source.close(); liveEvents = null; startEvents();
      }, 3000);
    }
    void api('/status').then(result => {
      if (liveEvents !== source || result.loggedIn) return;
      stopEvents(); state.data = null; state.csrf = null; state.quota = null; closeModal(); login(result.initialized);
    }).catch(() => {});
  };
}
async function refresh() {
  const version = snapshotVersion, data = await api('/snapshot');
  if (version === snapshotVersion) { state.data = data; state.cdks = data.cdks; state.keyMatches = null; state.keySearchError = ''; cdkVersion++; shell(); }
  startEvents();
}
async function quota() {
  state.quotaError = '';
  try { updateQuota(await api('/quota')); } catch (error) { state.quotaError = error.message; }
  // Preserve unsaved settings inputs when refreshing quota.
  const cards = $('#upstream-list'); if (cards) cards.innerHTML = upstreamTable();
}
function createKey() {
  keyForm();
}
function points(id) {
  const k = state.data.keys.find(k => k.id === Number(id)); if (!k) return;
  modal('调整 Anlas', `<form id="points-form" data-id="${k.id}"><div class="balance-summary"><span>${e(k.name)}<small>当前余额 / 预留 ${number(k.reserved)} Anlas</small></span><strong>${number(k.balance)}</strong></div><label>调整数量<div class="input-unit"><input name="delta" type="number" step="1" min="-1000000000" max="1000000000" placeholder="1000" required autofocus><span>Anlas</span></div></label><label>备注（可选）<input name="note" maxlength="160"></label><div class="form-error" role="alert"></div><div class="modal-actions"><button class="button subtle" type="button" data-action="close">取消</button><button class="button primary" type="submit">确认调整</button></div></form>`);
}
async function detail(id) {
  const k = state.data.keys.find(k => k.id === Number(id)); if (!k) return;
  const { token } = await api('/keys/'+k.id+'/reveal', { method: 'POST', body: {} });
  modal(k.name, '<code id="new-token" class="token-display">'+e(token)+'</code><dl class="details">'+
    '<dt>等级</dt><dd>'+tierName(k.tier)+'</dd><dt>本地体力</dt><dd>'+staminaText(k)+'</dd>'+
    '<dt>有效期</dt><dd>'+e(expiresText(k.expires_at))+'</dd><dt>创建时间</dt><dd>'+date(k.created_at)+'</dd>'+
    '<dt>当前余额</dt><dd>'+number(k.balance)+' Anlas</dd>'+
    '<dt>状态</dt><dd>'+keyStatus(k)+'</dd></dl><div class="modal-actions key-actions">'+
    '<button class="button subtle" data-action="edit-key" data-id="'+k.id+'">编辑 / 续期</button>'+
    '<button class="button '+(k.enabled ? 'danger' : 'subtle')+'" data-action="toggle-key" data-id="'+k.id+'">'+(k.enabled ? '停用密钥' : '启用密钥')+'</button>'+
    '<button class="button danger" data-action="remove-key" data-id="'+k.id+'">删除密钥</button>'+
    '<button class="button primary" data-action="copy-key">'+icon('copy')+'复制密钥</button></div>');
}
function removeKey(id) {
  const key = state.data.keys.find(k => k.id === Number(id)); if (!key) return;
  modal('删除访问密钥', `<p class="muted">确认删除「${e(key.name)}」？</p><code class="token-display">${e(key.prefix)}</code><p class="muted">删除后密钥立即失效并从列表移除，剩余 ${number(key.balance)} Anlas 不再可用。已有请求记录和 Anlas 流水会保留，此操作无法撤销。</p><div class="modal-actions"><button class="button subtle" data-action="close">取消</button><button class="button danger" data-action="confirm-remove-key" data-id="${key.id}">确认删除</button></div>`);
}
function jobDiagnosticsView(d) {
  if (!d) return '';
  const section = (title, text) => `<section class="diagnostic-section"><h3>${e(title)}</h3><pre class="diagnostic-text">${e(text)}</pre></section>`;
  return (d.response_content_type ? '<p class="field-note">上游响应类型：'+e(d.response_content_type)+'</p>' : '') +
    (d.upstream_error !== null ? section('NovelAI 错误原文（已脱敏）', d.upstream_error || '[上游返回空响应]') : '') +
    (d.failure_detail ? section('中断 / 解析原因', d.failure_detail) : '') +
    (d.request_json ? '<button class="button small subtle" data-action="job-parameters">请求参数</button>' : '');
}
function jobParametersView(request) {
  try { request = JSON.stringify(JSON.parse(request), null, 2); } catch { /* Display older text as saved. */ }
  return '<pre class="diagnostic-text">'+e(request)+'</pre>';
}
function openJobParameters(button) {
  const request = jobParameterSources.get(button); if (!request) return;
  const dialog = $('#job-parameters-dialog');
  dialog.innerHTML = '<div class="modal-head"><h2 id="job-parameters-title">请求参数</h2><button class="icon-button" data-action="close-job-parameters" aria-label="关闭">'+icon('close')+'</button></div>'+
    jobParametersView(request)+'<div class="modal-actions"><button class="button subtle" data-action="close-job-parameters">返回详情</button></div>';
  dialog.showModal();
}
function closeJobParameters() {
  const dialog = $('#job-parameters-dialog');
  if (dialog?.open) dialog.close();
  if (dialog) dialog.innerHTML = '';
}
async function jobDetail(id) {
  const j = visibleJobs().find(j => j.id === id); if (!j) return;
  const keyAvailable = state.data.keys.some(key => key.id === j.key_id);
  const mode = ({pool:'账号池', 'opus-pool':'Opus 免费池', 'anlas-pool':'Anlas 余额池', 'nai5-local-stamina':'V5 本地体力池', 'nai5-bound':'旧会员绑定上游', 'nai5-paid-pool':'NAI5 体力耗尽 · Anlas 池', 'nai5-stamina-pool':'NAI5 体力池 · 下游扣点'})[j.route_mode];
  modal('请求详情', '<dl class="details"><dt>请求编号</dt><dd><code>'+e(j.id)+'</code></dd>'+
    '<dt>访问密钥</dt><dd>'+e(j.key_name ?? '未识别密钥')+'<div id="job-key-secret" class="job-key-controls"><code>'+e(j.key_prefix ?? '—')+'</code><button class="button small subtle" data-action="reveal-job-key" data-id="'+j.key_id+'" '+(keyAvailable ? '' : 'disabled')+'>'+(keyAvailable ? '查看密钥' : j.key_id == null ? '未识别密钥' : '密钥已删除')+'</button></div></dd><dt>计费等级</dt><dd>'+(j.tier_snapshot ? tierName(j.tier_snapshot) : '—')+'</dd>'+
    '<dt>所用上游</dt><dd>'+e(j.upstream_name || '未选择上游')+'</dd><dt>路由方式</dt><dd>'+e(mode || '—')+'</dd>'+
    '<dt>请求阶段</dt><dd>'+e(j.stage || '—')+'</dd><dt>请求方法</dt><dd>'+e(j.request_method || 'POST')+'</dd><dt>响应状态</dt><dd>'+e(j.response_status ?? j.http_status ?? '—')+'</dd><dt>请求接口</dt><dd><code>'+e(j.endpoint)+'</code></dd><dt>上游 HTTP 状态</dt><dd>'+e(j.http_status ?? '—')+'</dd>'+
    '<dt>状态</dt><dd>'+badge(j.status)+'</dd><dt>本地报价</dt><dd>'+number(j.reserved)+' Anlas</dd>'+
    '<dt>上游消耗</dt><dd>'+number(j.upstream_spent)+' Anlas</dd>'+
    '<dt>体力消耗</dt><dd>'+(j.stamina_charged === null ? '—' : number(j.stamina_charged/100)+' 张')+'</dd><dt>实际扣点</dt><dd>'+(j.charged === null ? '处理中' : number(j.charged)+' Anlas')+'</dd></dl><p class="info-box">'+e(j.note)+'</p>'+
    '<div id="job-diagnostics"><p class="field-note">正在读取诊断信息…</p></div>'+
    '<div class="modal-actions"><button class="button subtle" data-action="close">关闭</button></div>');
  const container = $('#job-diagnostics');
  try {
    const result = await api('/jobs/' + encodeURIComponent(id));
    if (container?.isConnected) {
      container.innerHTML = jobDiagnosticsView(result.diagnostics);
      const button = $('[data-action="job-parameters"]', container);
      if (button) jobParameterSources.set(button, result.diagnostics.request_json);
    }
  } catch (error) {
    if (container?.isConnected) container.innerHTML = '<p class="field-note">诊断信息读取失败：'+e(error.message)+'</p>';
  }
}
async function revealJobKey(id) {
  const container = $('#job-key-secret'); if (!container) return;
  const { token } = await api('/keys/' + encodeURIComponent(id) + '/reveal', { method: 'POST', body: {} });
  if (!container.isConnected) return;
  container.innerHTML = '<code id="new-token" class="token-display">'+e(token)+'</code><button class="button small subtle" data-action="copy-key">复制密钥</button>';
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'sort-upstreams') {
    const key = button.dataset.sort;
    const direction = key === 'id' ? 'asc' : state.upstreamSort.key === key
      ? state.upstreamSort.direction === 'asc' ? 'desc' : 'asc'
      : ['priority', 'points', 'stamina'].includes(key) ? 'desc' : 'asc';
    state.upstreamSort = { key, direction };
    $('#upstream-list').innerHTML = upstreamTable();
    $(`[data-sort="${key}"]`)?.focus({ preventScroll: true });
    return;
  }
  if (action === 'close') return closeModal();
  if (action === 'job-parameters') return openJobParameters(button);
  if (action === 'close-job-parameters') return closeJobParameters();
  if (action === 'create') return createKey();
  if (action === 'edit-key') return keyForm(id);
  if (action === 'remove-key') return removeKey(id);
  if (action === 'add-upstream' || action === 'edit-upstream') return editUpstream(id);
  if (action === 'remove-upstream') return modal('移除上游', '<p class="muted">移除后不再分配请求，已有用量记录仍会保留。下游本地体力和点数不受影响。</p><div class="modal-actions"><button class="button subtle" data-action="close">取消</button><button class="button danger" data-action="confirm-remove-upstream" data-id="'+id+'">确认移除</button></div>');
  if (action === 'points') return points(id);
  if (action === 'key-detail') return withButton(button, () => detail(id));
  if (action === 'reveal-job-key') return withButton(button, () => revealJobKey(id));
  if (action === 'job') return jobDetail(id);
  if (action === 'job-status') {
    if (!['all', 'failed'].includes(button.dataset.status)) return;
    state.jobStatus = button.dataset.status; updateJobSearch(state.jobQuery); return renderView();
  }
  if (action === 'logs') { state.logs = button.dataset.tab; return renderView(); }
  if (action === 'mint-cdks') return mintCdks(id);
  if (action === 'void-cdk') {
    const hit = state.cdkHit; if (!hit) return;
    const redeemed = hit.status === 'redeemed';
    return modal(redeemed ? '作废并停用密钥' : '作废兑换码', `<form id="cdk-void-form" data-disable="${redeemed}"><p class="muted">${redeemed ? `这枚兑换码已兑换出密钥 ${e(hit.keyName)}（${e(hit.keyPrefix)}）。确认后密钥立即停用，买家无法继续使用；记录会保留，之后可在访问密钥里重新启用。` : '作废后买家提交这枚兑换码会提示已作废，记录会保留。阿奇索那边请另外补一枚新码。'}</p><label>备注（可选）<input name="reason" maxlength="160" placeholder="例如：淘宝订单退款"></label><div class="form-error" role="alert"></div><div class="modal-actions"><button class="button subtle" type="button" data-action="close">取消</button><button class="button danger" type="submit">${redeemed ? '作废并停用' : '确认作废'}</button></div></form>`);
  }
  if (action === 'reveal-cdk-key') return withButton(button, async () => { if (!state.data.keys.some(key => key.id === Number(id))) await refresh(); await detail(id); });
  if (action === 'password') return modal('修改管理员密码', '<form id="password-form"><label>当前密码<input name="current" type="password" autocomplete="current-password" required></label><label>新密码<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><label>确认新密码<input name="confirm" type="password" autocomplete="new-password" minlength="12" required></label><div class="form-error" role="alert"></div><div class="modal-actions"><button class="button primary" type="submit">保存新密码</button></div></form>');
  await withButton(button, async () => {
    if (action === 'quota') await quota();
    if (action === 'toggle-upstream') { const row = state.data.upstreams.find(u => u.id === Number(id)); await api('/upstreams/'+id, { method:'PUT', body:{ name:row.name, enabled:!row.enabled } }); await refresh(); toast(row.enabled ? '上游已停用' : '上游已启用'); }
    if (action === 'confirm-remove-upstream') { await api('/upstreams/'+id, { method:'DELETE' }); closeModal(); await refresh(); toast('上游已移除'); }
    if (action === 'confirm-remove-key') { await api('/keys/'+id, { method:'DELETE' }); closeModal(); await refresh(); toast('密钥已删除，历史记录已保留'); }
    if (action === 'copy-url') await copy(state.data.relayUrl, $('.address-field code'));
    if (action === 'copy-redeem-url') await copy($('#redeem-url').textContent, $('#redeem-url'));
    if (action === 'copy-cdks') { const node = $('#cdk-codes'); await copy(node.value, node); }
    if (action === 'export-cdks') {
      const result = await api('/cdks/export', { method: 'POST', body: { product: id } });
      if (!result.codes.length) throw new Error('这个商品没有未使用的兑换码');
      showCodes('未使用的兑换码', result.codes);
    }
    if (action === 'copy-key') { const token = $('#new-token'); await copy(token.textContent, token); }
    if (action === 'toggle-key') { const key = state.data.keys.find(k => k.id === Number(id)); await api(`/keys/${id}`, { method: 'POST', body: { enabled: !key.enabled } }); closeModal(); await refresh(); toast(key.enabled ? '密钥已停用' : '密钥已启用'); }
    if (action === 'logout') {
      stopEvents();
      try { await api('/logout', { method: 'POST', body: {} }); }
      catch (error) { startEvents(); throw error; }
      state.data = null; state.csrf = null; state.quota = null; closeModal(); await init();
    }
  });
});
document.addEventListener('compositionend', event => {
  if (event.target.id === 'job-key-search') updateJobSearch(event.target.value);
});
document.addEventListener('input', event => {
  if (event.target.id === 'job-key-search') { updateJobSearch(event.target.value, event.isComposing); return; }
  if (event.target.closest?.('#settings-form')) settingsDirty = true;
  if (event.target.id !== 'key-search') return;
  clearTimeout(keySearchTimer); keySearchVersion++;
  state.filter = event.target.value; state.keyMatches = null; state.keySearchError = '';
  $('#key-table').innerHTML = keyTable(filteredKeys());
  if (state.filter.trim()) keySearchTimer = setTimeout(searchKeys, 200);
});
document.addEventListener('change', event => {
  if (event.target.closest('#key-form')) syncKeyForm();
  if (event.target.closest('#settings-form')) settingsDirty = true;
});
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, button = $('button[type="submit"]', form), values = Object.fromEntries(new FormData(form));
  const errorNode = $('.form-error', form); if (errorNode) errorNode.textContent = '';
  await withButton(button, async () => {
    try {
      if (form.id === 'auth-form') {
        if (form.dataset.setup === 'true' && values.confirm !== values.password) throw new Error('两次输入的密码不一致');
        const result = await api(form.dataset.setup === 'true' ? '/setup' : '/login', { method: 'POST', body: values }); state.csrf = result.csrf; await refresh();
      }
      if (form.id === 'key-form') {
        const body = { name: values.name, tier: values.tier };
        if (values.tier === 'member') body.staminaPercent = Number(values.staminaPercent);
        if (values.expiryMode === 'never') body.expiresAt = null;
        if (values.expiryMode === 'days') body.validDays = Number(values.validDays);
        if (values.expiryMode === 'date') body.expiresAt = new Date(values.expiresAt).getTime();
        if (!form.dataset.id) body.points = Number(values.points);
        const result = await api('/keys' + (form.dataset.id ? '/' + form.dataset.id : ''), { method: 'POST', body });
        await refresh();
        if (form.dataset.id) { closeModal(); toast('密钥设置已保存'); return; }
        modal('密钥已创建', `<div class="success-mark">${icon('check')}</div><code id="new-token" class="token-display">${e(result.token)}</code><div class="key-connect"><span>连接地址</span><code>${e(state.data.relayUrl)}</code></div><div class="modal-actions"><button class="button subtle" data-action="close">关闭</button><button class="button primary" data-action="copy-key">${icon('copy')}复制密钥</button></div>`);
      }
      if (form.id === 'points-form') { await api(`/keys/${form.dataset.id}/points`, { method: 'POST', body: { delta: Number(values.delta), note: values.note } }); closeModal(); await refresh(); toast('Anlas 已调整，流水已记录'); }
      if (form.id === 'upstream-form') { await api('/upstreams'+(form.dataset.id ? '/'+form.dataset.id : ''), {method:form.dataset.id ? 'PUT' : 'POST', body:{name:values.name, note:values.note, priority:Number(values.priority), token:values.token.trim(), enabled:values.enabled === 'on'}}); closeModal(); await refresh(); toast('上游已保存'); }
      if (form.id === 'settings-form') {
        await api('/settings', { method: 'PUT', body: { enabled: values.enabled === 'on', origins: values.origins.split('\n').map(x => x.trim()).filter(Boolean) } }); settingsDirty = false; await refresh(); toast('设置已保存');
      }
      if (form.id === 'cdk-search-form') {
        state.cdkQuery = String(values.code || '');
        state.cdkHit = await api('/cdks/search', { method: 'POST', body: { code: state.cdkQuery } });
        const node = $('#cdk-search-result'); if (node) node.innerHTML = cdkHitView();
      }
      if (form.id === 'cdk-void-form') {
        state.cdkHit = await api('/cdks/void', { method: 'POST', body: { code: state.cdkQuery, reason: values.reason, disableKey: form.dataset.disable === 'true' } });
        closeModal(); toast(form.dataset.disable === 'true' ? '兑换码已作废，密钥已停用' : '兑换码已作废');
        const node = $('#cdk-search-result'); if (node) node.innerHTML = cdkHitView();
        void loadCdks();
      }
      if (form.id === 'cdk-form') {
        const result = await api('/cdks', { method: 'POST', body: { product: form.dataset.product, count: Number(values.count) } });
        showCodes('兑换码已生成', result.codes);
        void loadCdks();
      }
      if (form.id === 'password-form') {
        if (values.password !== values.confirm) throw new Error('两次输入的密码不一致');
        stopEvents();
        try { const result = await api('/password', { method: 'POST', body: values }); state.csrf = result.csrf; closeModal(); toast('管理员密码已更新，其他会话已退出'); }
        finally { startEvents(); }
      }
    } catch (error) { if (errorNode?.isConnected) errorNode.textContent = error.message; else throw error; }
  });
});
$('#dialog').addEventListener('click', event => { if (event.target === $('#dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeModal(); } });
$('#dialog').addEventListener('close', () => { $('#dialog').innerHTML = ''; });
$('#job-parameters-dialog').addEventListener('close', () => { $('#job-parameters-dialog').innerHTML = ''; });
window.addEventListener('hashchange', () => { const view = location.hash.slice(1); state.view = titles[view] ? view : 'overview'; settingsDirty = false; if (state.data) shell(); });
window.addEventListener('pagehide', stopEvents);
window.addEventListener('pageshow', () => { if (state.data) startEvents(); });
async function init() {
  const result = await api('/status'); state.csrf = result.csrf;
  if (!result.loggedIn) { stopEvents(); return login(result.initialized); }
  state.view = titles[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  await refresh();
}
init().catch(error => { $('#app').innerHTML = `<div class="boot"><h2>暂时无法打开控制台</h2><p>${e(error.message)}</p><button class="button primary" data-action="reload">重新加载</button></div>`; $('[data-action="reload"]').addEventListener('click', () => location.reload()); });
