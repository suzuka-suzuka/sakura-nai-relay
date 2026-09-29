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
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  logout: '<path d="M9 4H4v16h5m7-12 4 4-4 4M8 12h12"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  coins: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 4 16 4 16 0V6M4 12v6c0 4 16 4 16 0v-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>', shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.grid}</svg>`;
const flower = '<img src="/favicon.svg" alt="" class="flower">';
const state = { csrf: null, view: 'overview', data: null, quota: null, quotaError: '', filter: '', logs: 'jobs' };
const titles = { overview: '运行概览', keys: '访问密钥', usage: '用量记录', settings: '上游设置' };

function toast(message, bad = false) {
  const node = document.createElement('div'); node.className = `toast ${bad ? 'bad' : ''}`; node.textContent = message; $('#toasts').append(node); setTimeout(() => node.remove(), 5000);
}
async function api(path, options = {}) {
  const response = await fetch(`/admin/api${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && state.data && !path.includes('password')) { state.data = null; await init(); } throw new Error(data.error || '请求失败'); }
  return data;
}
async function withButton(button, fn) {
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.classList.add('working'); }
  try { await fn(); } catch (err) { toast(err.message, true); }
  finally { if (button) { button.disabled = false; button.classList.remove('working'); } }
}
async function copy(text) { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
function modal(title, content, subtitle = '') {
  const dialog = $('#dialog');
  dialog.innerHTML = `<div class="modal-head"><div><h2 id="dialog-title">${e(title)}</h2>${subtitle ? `<p class="muted">${e(subtitle)}</p>` : ''}</div><button class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></div>${content}`;
  if (!dialog.open) dialog.showModal();
}
function closeModal() { $('#dialog').close(); $('#dialog').innerHTML = ''; }
function badge(status) {
  const names = { completed: ['成功', 'green'], rejected: ['已拒绝', 'muted'], review: ['待核对', 'amber'], running: ['处理中', 'pink'], resolved: ['已核对', 'green'] };
  const [name, color] = names[status] ?? ['未知', 'muted']; return `<span class="badge ${color}"><i></i>${name}</span>`;
}
const empty = (title, hint, action = '') => `<div class="empty"><span class="empty-icon">${icon('key')}</span><h3>${title}</h3>${hint ? `<p>${hint}</p>` : ""}${action}</div>`;

function login(initialized) {
  $('#app').innerHTML = `<main class="auth"><aside class="auth-art"><div class="brand">${flower}<span>Sakura <b>Relay</b></span></div><div class="art-copy"><h1>密钥与用量，<br>统一管理。</h1></div><div class="orb orb-one"></div><div class="orb orb-two"></div><div class="flower-art">✿</div></aside><section class="auth-form"><div class="auth-inner"><span class="auth-symbol">${flower}</span><h2>${initialized ? '登录' : '初始化管理员'}</h2><form id="auth-form" data-setup="${!initialized}">${initialized ? '' : '<label>初始化码<input name="code" autocomplete="off" required placeholder="填写初始化码"></label><p class="field-note">初始化码见服务端 setup-code.txt。</p>'}<label>管理员密码<input name="password" type="password" autocomplete="${initialized ? 'current-password' : 'new-password'}" required minlength="12" maxlength="256" placeholder="${initialized ? '输入你的密码' : '至少 12 个字符'}"></label>${initialized ? '' : '<label>确认密码<input name="confirm" type="password" autocomplete="new-password" required minlength="12" placeholder="再次输入密码"></label>'}<div class="form-error" role="alert"></div><button class="button primary full" type="submit">${initialized ? '进入控制台' : '创建管理员'}${icon('arrow')}</button></form></div></section></main>`;
}
function shell() {
  const title = titles[state.view], d = state.data;
  $('#app').innerHTML = `<div class="workspace"><aside class="sidebar"><a class="brand" href="#overview" aria-label="Sakura Relay 概览">${flower}<span>Sakura <b>Relay</b></span></a><nav aria-label="主导航">${[['overview','grid','运行概览'],['keys','key','访问密钥'],['usage','activity','用量记录'],['settings','settings','上游设置']].map(([id, symbol, text]) => `<a href="#${id}" aria-label="${text}" class="nav-item ${state.view === id ? 'active' : ''}" ${state.view === id ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${text}</span>${id === 'keys' ? '<small>'+d.keys.length+'</small>' : ''}${id === 'usage' && d.stats.reviews ? '<i class="notice-dot"></i>' : ''}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="connection-state"><i class="status-dot ${d.settings.configured && d.settings.enabled ? 'online' : ''}"></i><div>${d.settings.configured ? d.settings.enabled ? '中转已启用' : '中转已暂停' : '未配置上游'}</div></div><div class="admin-card"><div class="avatar">S</div><div>管理员</div><button class="icon-button" data-action="logout" aria-label="退出登录">${icon('logout')}</button></div></div></aside><main class="main"><div class="content"><section class="page-heading"><h1>${title}</h1><div class="heading-actions">${state.view === 'keys' || state.view === 'overview' ? '<button class="button primary" data-action="create">'+icon('plus')+'创建密钥</button>' : ''}<button class="icon-button bordered" data-action="refresh" aria-label="刷新数据">${icon('refresh')}</button></div></section><div id="view"></div></div></main></div>`;
  renderView();
}
function quotaFor(id) { return state.quota?.upstreams.find(q => q.id === id); }
function remaining(q) { const u = q?.account?.usage; return u ? u.isNegative ? 0 : Math.max(0, Math.min(100, u.percent)) : null; }
function upstreamBadge(row) {
  const [text, color] = !row.enabled ? ['已停用', 'muted'] : !row.weight ? ['暂停分配', 'muted'] : row.reviews ? ['待核对', 'amber'] : row.busy ? ['生成中', 'pink'] : row.cooldownUntil > Date.now() ? ['冷却中', 'amber'] : ['已启用', 'green'];
  return '<span class="badge '+color+'"><i></i>'+text+'</span>';
}
function quotaPanel() {
  const q = state.quota, rows = state.data.upstreams;
  return `<div class="panel quota-panel"><div class="panel-title"><h2>上游额度</h2><button class="icon-button" data-action="quota" aria-label="刷新全部额度" title="刷新额度" ${!rows.length ? 'disabled' : ''}>${icon('refresh')}</button></div><div class="quota-balance"><span>Anlas 合计</span><strong>${q ? number(q.totalAnlas) : '—'}<small>Anlas</small></strong></div><div class="pool-quota-list">${rows.map(row => { const account = quotaFor(row.id), pct = remaining(account); return `<div class="pool-quota-item"><div class="pool-quota-heading"><strong>${e(row.name)}</strong><span>${account?.ok ? number(account.account.relay.balance) + ' Anlas' : '—'}</span></div><div class="quota-row"><span>NAI 5 剩余</span><b>${pct === null ? '—' : pct.toFixed(1) + '%'}</b></div><div class="progress-track"><div style="width:${pct ?? 0}%"></div></div>${account && !account.ok ? '<p class="field-note">查询失败</p>' : ''}</div>`; }).join('') || '<p class="muted">暂无上游</p>'}</div>${state.quotaError || q ? '<p class="field-note">'+e(state.quotaError || (q.failed ? q.failed + ' 个账户查询失败，未计入合计' : date(q.fetchedAt) + ' 更新'))+'</p>' : ''}</div>`;
}
function upstreamCards() {
  const rows = state.data.upstreams;
  return rows.length ? rows.map(row => {
    const q = quotaFor(row.id), pct = remaining(q);
    return `<article class="upstream-card"><div class="upstream-card-head"><span class="upstream-mark">N</span><div class="upstream-card-name"><h3>${e(row.name)}</h3><code>•••• ${e(row.suffix)}</code></div>${upstreamBadge(row)}</div><div class="upstream-metrics"><div><span>账户余额</span><strong>${q?.ok ? number(q.account.relay.balance) : '—'}<small>Anlas</small></strong></div><div><span>路由权重</span><strong>${row.weight}</strong></div></div><div class="quota-row"><span>NAI 5 剩余</span><b>${pct === null ? '—' : pct.toFixed(1) + '%'}</b></div><div class="progress-track"><div style="width:${pct ?? 0}%"></div></div>${row.error || q && !q.ok ? '<p class="field-note">'+e(row.error || q.error)+'</p>' : ''}<div class="upstream-card-actions"><button class="button small subtle" data-action="edit-upstream" data-id="${row.id}">编辑上游</button><button class="button small text-button" data-action="toggle-upstream" data-id="${row.id}">${row.enabled ? '停用' : '启用'}</button></div></article>`;
  }).join('') : empty('暂无上游', '', '<button class="button subtle" data-action="add-upstream">添加上游</button>');
}
function editUpstream(id) {
  const row = state.data.upstreams.find(u => u.id === Number(id));
  modal(row ? '编辑上游' : '添加上游', `<form id="upstream-form" data-id="${row?.id ?? ''}"><label>上游名称<input name="name" value="${e(row?.name ?? '')}" placeholder="例如：樱花 · 主账户" maxlength="64" required autofocus></label><label>NovelAI 官方 Key<input name="token" type="password" autocomplete="new-password" maxlength="4096" placeholder="${row ? '留空保留已保存的 Key · 尾号 ' + e(row.suffix) : 'pst-…'}" ${row ? '' : 'required'}></label><label>路由权重<input name="weight" type="number" min="0" max="1000" step="1" value="${row?.weight ?? 1}" required></label><p class="field-note">按权重分配，设为 0 时暂停。</p><div class="toggle-row"><div><strong>启用上游</strong></div><label class="switch"><input name="enabled" type="checkbox" ${!row || row.enabled ? 'checked' : ''} aria-label="启用上游"><span></span></label></div><div class="form-error" role="alert"></div><div class="modal-actions">${row ? '<button class="button danger" type="button" data-action="remove-upstream" data-id="'+row.id+'">移除</button>' : ''}<button class="button subtle" type="button" data-action="close">取消</button><button class="button primary" type="submit">${row ? '保存修改' : '添加上游'}</button></div></form>`);
}
function usageChart(days, metric, title, unit) {
  const max = Math.max(1, ...days.map(day => day[metric] ?? 0));
  const total = days.reduce((sum, day) => sum + (day[metric] ?? 0), 0);
  return `<section class="panel activity-panel usage-${metric}"><div class="panel-title"><h2>${title}</h2></div><div class="chart" aria-label="${title}柱状图">${days.map(day => {
    const value = day[metric] ?? 0;
    return `<div class="chart-column" title="${day.label}：${number(value)} ${unit}"><span class="chart-number">${number(value)}</span><div class="bar-space"><div class="bar ${value ? '' : 'zero'}" style="height:${value ? Math.max(4, value / max * 100) : 2}%"></div></div><span class="chart-date">${day.label}</span></div>`;
  }).join('')}</div><div class="chart-caption"><span>7 天合计</span><b>${number(total)} <small>${unit}</small></b></div></section>`;
}
function overview() {
  const d = state.data, available = d.keys.reduce((sum, key) => sum + key.balance - key.reserved, 0);
  const cards = [['访问密钥', number(d.keys.length), `${d.keys.filter(k => k.enabled).length} 个启用中`, 'key'], ['密钥可用 Anlas', number(available), '', 'coins'], ['累计消耗', number(d.stats.spent), '', 'activity'], ['请求总数', number(d.stats.requests), d.stats.reviews ? `${d.stats.reviews} 笔待核对` : '', 'clock']];
  const now = Date.now();
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(now - (6 - i) * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    return { ...d.trend.find(item => item.day === day), label: Number(day.slice(5, 7)) + '/' + Number(day.slice(8, 10)) };
  });
  return `${!d.settings.configured ? `<div class="onboarding"><span class="onboarding-icon">${icon('settings')}</span><div><strong>尚未配置上游</strong></div><a href="#settings" class="button text-button">添加上游 ${icon('arrow')}</a></div>` : ''}${d.stats.reviews ? `<a class="review-banner" href="#usage">${icon('info')}有 ${d.stats.reviews} 笔用量待核对，相关上游暂停分配，其他上游可继续使用。${icon('arrow')}</a>` : ''}<div class="stats-grid">${cards.map(([name,value,hint,symbol], i) => `<article class="stat-card ${i === 2 ? 'rose' : ''}"><div>${name}<span>${icon(symbol)}</span></div><strong>${value}${i === 1 || i === 2 ? '<small>Anlas</small>' : ''}</strong>${hint ? `<p>${hint}</p>` : ""}</article>`).join('')}</div><div class="usage-grid">${usageChart(days, "spent", "最近 7 天 Anlas 用量", "Anlas")}${usageChart(days, "requests", "最近 7 天请求次数", "次")}</div><div class="overview-grid"><section class="panel recent-panel"><div class="panel-title"><div><h2>最近创建的密钥</h2></div><a class="text-link" href="#keys">查看全部 ${icon('arrow')}</a></div>${keyTable(d.keys.slice(0, 4))}</section>${quotaPanel()}</div>`;
}
function keyTable(keys) {
  if (!keys.length) return empty('暂无访问密钥', '', '<button class="button subtle" data-action="create">创建密钥</button>');
  return `<div class="table-scroll"><table><thead><tr><th>密钥名称</th><th>状态</th><th>可用 Anlas</th><th>最近使用</th><th class="right">管理</th></tr></thead><tbody>${keys.map(k => `<tr><td><div class="key-cell"><span class="key-avatar">${icon('key')}</span><div><strong>${e(k.name)}</strong><code>${e(k.prefix)}</code></div></div></td><td><span class="badge ${k.enabled ? 'green' : 'muted'}"><i></i>${k.enabled ? '已启用' : '已停用'}</span></td><td><span class="point-value">${number(k.balance - k.reserved)}</span><small class="cell-note">${k.reserved ? `预留 ${number(k.reserved)} Anlas` : 'Anlas'}</small></td><td class="date-cell">${date(k.last_used_at)}</td><td class="right"><button class="button small subtle" data-action="points" data-id="${k.id}">调整 Anlas</button><button class="button small subtle" data-action="key-detail" data-id="${k.id}" aria-label="查看 ${e(k.name)} 的密钥">查看密钥</button></td></tr>`).join('')}</tbody></table></div>`;
}
function keysView() { return `<div class="panel"><div class="panel-title"><div><h2>全部密钥 <span class="count">${state.data.keys.length}</span></h2></div><label class="search">${icon('search')}<input id="key-search" type="search" placeholder="搜索名称或密钥" value="${e(state.filter)}" aria-label="搜索密钥"></label></div><div id="key-table">${keyTable(filteredKeys())}</div></div>`; }
function filteredKeys() { return state.data.keys.filter(k => `${k.name} ${k.prefix}`.toLowerCase().includes(state.filter.toLowerCase())); }
function usageView() {
  const d = state.data;
  return `${d.stats.reviews ? `<div class="review-banner">${icon('info')}待核对请求保留预留 Anlas，结算后恢复对应上游。</div>` : ''}<div class="panel"><div class="panel-title"><div class="tabs"><button data-action="logs" data-tab="jobs" class="${state.logs === 'jobs' ? 'selected' : ''}">请求记录</button><button data-action="logs" data-tab="ledger" class="${state.logs === 'ledger' ? 'selected' : ''}">Anlas 流水</button></div><span class="muted">最近 100 条</span></div>${state.logs === 'jobs' ? (d.jobs.length ? `<div class="table-scroll"><table><thead><tr><th>请求 / 时间</th><th>访问密钥 / 上游</th><th>模型 / 功能</th><th>状态</th><th>Anlas</th><th></th></tr></thead><tbody>${d.jobs.map(j => `<tr><td><code class="job-id">${e(j.id.slice(0,10))}</code><small class="cell-note">${date(j.created_at)}</small></td><td>${e(j.key_name)}<small class="cell-note">${e(j.upstream_name || "旧记录")}</small></td><td><span class="model-name">${e(j.model)}</span><small class="cell-note">${e(j.endpoint.replace('/ai/', ''))}</small></td><td>${badge(j.status)}</td><td><strong>${j.charged === null ? '—' : number(j.charged)}</strong>${j.status === 'review' || j.status === 'running' ? `<small class="cell-note">预留 ${j.reserved}</small>` : ''}</td><td><button class="button small subtle" data-action="job" data-id="${e(j.id)}">${j.status === 'review' ? '核对用量' : '详情'}</button></td></tr>`).join('')}</tbody></table></div>` : empty('暂无请求记录', '')) : (d.ledger.length ? `<div class="table-scroll"><table><thead><tr><th>时间</th><th>访问密钥</th><th>类型</th><th>Anlas 变化</th><th>备注</th></tr></thead><tbody>${d.ledger.map(l => `<tr><td class="date-cell">${date(l.created_at)}</td><td>${e(l.key_name)}</td><td>${({ grant: '创建分配', adjust: '管理调整', usage: '用量结算' })[l.kind]}</td><td><strong class="${l.delta > 0 ? 'positive' : ''}">${l.delta > 0 ? '+' : ''}${number(l.delta)}</strong></td><td>${e(l.note)}</td></tr>`).join('')}</tbody></table></div>` : empty('暂无 Anlas 流水', ''))}</div>`;
}
function settingsView() {
  const s = state.data.settings, rows = state.data.upstreams;
  return `<section class="pool-section"><div class="pool-heading"><h2>上游账户 <span class="count">${rows.length}</span></h2><button class="button primary" data-action="add-upstream">${icon('plus')}添加上游</button></div><div id="upstream-cards" class="upstream-cards">${upstreamCards()}</div></section><form class="panel settings-form" id="settings-form"><div class="panel-title"><h2>访问设置</h2><button class="button small subtle" type="button" data-action="password">修改密码</button></div><div class="access-fields"><div><label>允许的来源<textarea name="origins" rows="3" placeholder="https://example.com">${e(s.origins.join('\n'))}</textarea></label><p class="field-note">每行一个来源，包含协议和端口，不含路径。</p></div><div><label id="relay-address-label">中转地址</label><div class="address-field" aria-labelledby="relay-address-label"><code>${e(state.data.relayUrl)}</code><button class="icon-button" type="button" data-action="copy-url" aria-label="复制中转地址">${icon('copy')}</button></div><div class="toggle-row"><strong>开放中转</strong><label class="switch"><input name="enabled" type="checkbox" ${s.enabled ? 'checked' : ''} aria-label="开放中转"><span></span></label></div></div></div><div class="form-footer"><button class="button primary" type="submit">保存设置</button></div></form>`;
}
function renderView() { $('#view').innerHTML = ({ overview, keys: keysView, usage: usageView, settings: settingsView })[state.view](); }
async function refresh() { state.data = await api('/snapshot'); shell(); }
async function quota() {
  state.quotaError = '';
  try { state.quota = await api('/quota'); } catch (error) { state.quota = null; state.quotaError = error.message; }
  // Preserve unsaved settings inputs when refreshing quota.
  const panel = $('.quota-panel'); if (panel) panel.outerHTML = quotaPanel();
  const cards = $('#upstream-cards'); if (cards) cards.innerHTML = upstreamCards();
}
function createKey() {
  modal('创建访问密钥', '<form id="create-form"><label>名称<input name="name" placeholder="例如：个人使用" maxlength="64" required autofocus></label><label>初始 Anlas<div class="input-unit"><input name="points" type="number" min="0" max="1000000000" step="1" value="1000" required><span>Anlas</span></div></label><div class="form-error" role="alert"></div><div class="modal-actions"><button type="button" class="button subtle" data-action="close">取消</button><button class="button primary" type="submit">创建密钥 '+icon('arrow')+'</button></div></form>');
}
function points(id) {
  const k = state.data.keys.find(k => k.id === Number(id)); if (!k) return;
  modal('调整 Anlas', `<form id="points-form" data-id="${k.id}"><div class="balance-summary"><span>${e(k.name)}<small>当前余额 / 预留 ${number(k.reserved)} Anlas</small></span><strong>${number(k.balance)}</strong></div><label>调整数量<div class="input-unit"><input name="delta" type="number" step="1" min="-1000000000" max="1000000000" placeholder="1000" required autofocus><span>Anlas</span></div></label><p class="field-note">正数增加，负数扣减；不能扣减已预留的 Anlas。</p><label>备注<input name="note" maxlength="160" placeholder="例如：补充创作额度" required></label><div class="form-error" role="alert"></div><div class="modal-actions"><button class="button subtle" type="button" data-action="close">取消</button><button class="button primary" type="submit">确认调整</button></div></form>`);
}
async function detail(id) {
  const k = state.data.keys.find(k => k.id === Number(id)); if (!k) return;
  const { token } = await api(`/keys/${k.id}/reveal`, { method: 'POST', body: {} });
  modal(k.name, `${token ? `<code id="new-token" class="token-display">${e(token)}</code>` : `<code class="token-display">${e(k.prefix)}</code><p class="info-box">旧版未保存完整密钥。客户端使用一次后即可查看；若已丢失，可重新生成。</p>`}<dl class="details"><dt>创建时间</dt><dd>${date(k.created_at)}</dd><dt>当前余额</dt><dd>${number(k.balance)} Anlas</dd><dt>预留 Anlas</dt><dd>${number(k.reserved)} Anlas</dd><dt>状态</dt><dd>${k.enabled ? '已启用' : '已停用'}</dd></dl><div class="modal-actions key-actions"><button class="button subtle" data-action="close">关闭</button><button class="button ${k.enabled ? 'danger' : 'subtle'}" data-action="toggle-key" data-id="${k.id}">${k.enabled ? '停用密钥' : '启用密钥'}</button>${token ? `<button class="button primary" data-action="copy-key">${icon('copy')}复制密钥</button>` : `<button class="button primary" data-action="regenerate-key" data-id="${k.id}">重新生成</button>`}</div>`);
}
function jobDetail(id) {
  const j = state.data.jobs.find(j => j.id === id); if (!j) return;
  modal(j.status === 'review' ? '核对实际用量' : '请求详情', `<dl class="details"><dt>请求编号</dt><dd><code>${e(j.id)}</code></dd><dt>访问密钥</dt><dd>${e(j.key_name)}</dd><dt>所用上游</dt><dd>${e(j.upstream_name || "旧记录")}</dd><dt>状态</dt><dd>${badge(j.status)}</dd><dt>预留 Anlas</dt><dd>${number(j.reserved)}</dd><dt>上游余额 · 前</dt><dd>${number(j.before_balance)}</dd><dt>上游余额 · 后</dt><dd>${j.after_balance === null ? '未确认' : number(j.after_balance)}</dd><dt>结算 Anlas</dt><dd>${j.charged === null ? '待核对' : number(j.charged)}</dd></dl><p class="info-box">${e(j.note)}</p>${j.status === 'review' ? `<form id="resolve-form" data-id="${e(j.id)}"><label>确认实际消耗<input type="number" min="0" max="1000000000" step="1" name="charged" required placeholder="请输入实际 Anlas 消耗"></label><label>核对备注<input name="note" maxlength="160" required placeholder="填写核对依据"></label><p class="field-note">确认未扣费时填 0。结算后释放预留，不会重新提交生成。</p><div class="form-error" role="alert"></div><div class="modal-actions"><button class="button subtle" type="button" data-action="close">取消</button><button class="button primary" type="submit">确认结算</button></div></form>` : '<div class="modal-actions"><button class="button subtle" data-action="close">关闭</button></div>'}`);
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'close') return closeModal();
  if (action === 'create') return createKey();
  if (action === 'add-upstream' || action === 'edit-upstream') return editUpstream(id);
  if (action === 'remove-upstream') return modal('移除上游', '<p class="muted">移除后不再分配请求，已有用量记录仍会保留。</p><div class="modal-actions"><button class="button subtle" data-action="close">取消</button><button class="button danger" data-action="confirm-remove-upstream" data-id="'+id+'">确认移除</button></div>');
  if (action === 'points') return points(id);
  if (action === 'key-detail') return withButton(button, () => detail(id));
  if (action === 'regenerate-key') return modal('重新生成密钥', '<p class="muted">旧密钥将立即失效，需要在客户端换成新密钥。Anlas、状态和使用记录保留。</p><div class="modal-actions"><button class="button subtle" data-action="key-detail" data-id="'+id+'">取消</button><button class="button danger" data-action="confirm-regenerate-key" data-id="'+id+'">确认重新生成</button></div>');
  if (action === 'job') return jobDetail(id);
  if (action === 'logs') { state.logs = button.dataset.tab; return renderView(); }
  if (action === 'password') return modal('修改管理员密码', '<form id="password-form"><label>当前密码<input name="current" type="password" autocomplete="current-password" required></label><label>新密码<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><label>确认新密码<input name="confirm" type="password" autocomplete="new-password" minlength="12" required></label><div class="form-error" role="alert"></div><div class="modal-actions"><button class="button primary" type="submit">保存新密码</button></div></form>');
  await withButton(button, async () => {
    if (action === 'refresh') { await refresh(); if (state.data.settings.configured) await quota(); }
    if (action === 'quota') await quota();
    if (action === 'toggle-upstream') { const row = state.data.upstreams.find(u => u.id === Number(id)); await api('/upstreams/'+id, { method:'PUT', body:{ name:row.name, weight:row.weight, enabled:!row.enabled } }); await refresh(); toast(row.enabled ? '上游已停用' : '上游已启用'); }
    if (action === 'confirm-remove-upstream') { await api('/upstreams/'+id, { method:'DELETE' }); closeModal(); await refresh(); await quota(); toast('上游已移除'); }
    if (action === 'copy-url') await copy(state.data.relayUrl);
    if (action === 'copy-key') await copy($('#new-token').textContent);
    if (action === 'confirm-regenerate-key') { await api(`/keys/${id}/regenerate`, { method: 'POST', body: { confirm: true } }); await refresh(); await detail(id); toast('已生成新密钥'); }
    if (action === 'toggle-key') { const key = state.data.keys.find(k => k.id === Number(id)); await api(`/keys/${id}`, { method: 'POST', body: { enabled: !key.enabled } }); closeModal(); await refresh(); toast(key.enabled ? '密钥已停用' : '密钥已启用'); }
    if (action === 'logout') { await api('/logout', { method: 'POST', body: {} }); state.data = null; state.csrf = null; state.quota = null; await init(); }
  });
});
document.addEventListener('input', event => { if (event.target.id === 'key-search') { state.filter = event.target.value; $('#key-table').innerHTML = keyTable(filteredKeys()); } });
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, button = $('button[type="submit"]', form), values = Object.fromEntries(new FormData(form));
  const errorNode = $('.form-error', form); if (errorNode) errorNode.textContent = '';
  await withButton(button, async () => {
    try {
      if (form.id === 'auth-form') {
        if (form.dataset.setup === 'true' && values.confirm !== values.password) throw new Error('两次输入的密码不一致');
        const result = await api(form.dataset.setup === 'true' ? '/setup' : '/login', { method: 'POST', body: values }); state.csrf = result.csrf; await refresh(); if (state.data.settings.configured) await quota();
      }
      if (form.id === 'create-form') {
        const result = await api('/keys', { method: 'POST', body: { name: values.name, points: Number(values.points) } });
        await refresh();
        modal('密钥已创建', `<div class="success-mark">${icon('check')}</div><code id="new-token" class="token-display">${e(result.token)}</code><div class="key-connect"><span>连接地址</span><code>${e(state.data.relayUrl)}</code></div><div class="modal-actions"><button class="button subtle" data-action="close">关闭</button><button class="button primary" data-action="copy-key">${icon('copy')}复制密钥</button></div>`);
      }
      if (form.id === 'points-form') { await api(`/keys/${form.dataset.id}/points`, { method: 'POST', body: { delta: Number(values.delta), note: values.note } }); closeModal(); await refresh(); toast('Anlas 已调整，流水已记录'); }
      if (form.id === 'resolve-form') { await api(`/jobs/${form.dataset.id}/resolve`, { method: 'POST', body: { charged: Number(values.charged), note: values.note } }); closeModal(); await refresh(); toast('用量已结算'); }
      if (form.id === 'upstream-form') { await api('/upstreams'+(form.dataset.id ? '/'+form.dataset.id : ''), {method:form.dataset.id ? 'PUT' : 'POST', body:{name:values.name, token:values.token.trim(), weight:Number(values.weight), enabled:values.enabled === 'on'}}); closeModal(); await refresh(); await quota(); toast('上游已保存'); }
      if (form.id === 'settings-form') {
        await api('/settings', { method: 'PUT', body: { enabled: values.enabled === 'on', origins: values.origins.split('\n').map(x => x.trim()).filter(Boolean) } }); await refresh(); await quota(); toast('设置已保存');
      }
      if (form.id === 'password-form') {
        if (values.password !== values.confirm) throw new Error('两次输入的密码不一致');
        const result = await api('/password', { method: 'POST', body: values }); state.csrf = result.csrf; closeModal(); toast('管理员密码已更新，其他会话已退出');
      }
    } catch (error) { if (errorNode?.isConnected) errorNode.textContent = error.message; else throw error; }
  });
});
$('#dialog').addEventListener('click', event => { if (event.target === $('#dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeModal(); } });
$('#dialog').addEventListener('close', () => { $('#dialog').innerHTML = ''; });
window.addEventListener('hashchange', () => { const view = location.hash.slice(1); state.view = titles[view] ? view : 'overview'; if (state.data) shell(); });
async function init() {
  const result = await api('/status'); state.csrf = result.csrf;
  if (!result.loggedIn) return login(result.initialized);
  state.view = titles[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  await refresh(); if (state.data.settings.configured) await quota();
}
init().catch(error => { $('#app').innerHTML = `<div class="boot"><h2>暂时无法打开控制台</h2><p>${e(error.message)}</p><button class="button primary" data-action="reload">重新加载</button></div>`; $('[data-action="reload"]').addEventListener('click', () => location.reload()); });
