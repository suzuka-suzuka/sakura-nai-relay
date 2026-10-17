const $ = (selector, root = document) => root.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tierName = tier => tier === 'member' ? '会员' : '普通';
const expiresText = value => value === null ? '永久有效' : new Date(value).toLocaleString('zh-CN', { hour12: false });

function toast(message, bad = false) {
  let stack = $('#toasts');
  if (!stack) { stack = document.createElement('div'); stack.id = 'toasts'; stack.setAttribute('role', 'status'); document.body.append(stack); }
  const node = document.createElement('div'); node.className = `toast ${bad ? 'bad' : ''}`; node.textContent = message; stack.append(node); setTimeout(() => node.remove(), 5000);
}
async function copy(text, source) {
  if (typeof navigator.clipboard?.writeText === 'function') {
    try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); return; }
    catch { /* Fall back to selecting the visible text. */ }
  }
  const field = document.createElement('textarea');
  field.value = text; field.readOnly = true;
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0';
  document.body.append(field);
  try { field.focus(); field.select(); if (document.execCommand('copy')) { toast('已复制到剪贴板'); return; } }
  catch { /* Keep the text selected below. */ }
  finally { field.remove(); }
  if (source) { const selection = document.getSelection(), range = document.createRange(); range.selectNodeContents(source); selection?.removeAllRanges(); selection?.addRange(range); }
  toast('浏览器未允许自动复制，已选中文本，请按 Ctrl+C 或长按复制', true);
}

function showResult(data) {
  const box = $('#redeem-result');
  const stamina = data.tier === 'member' ? `体力上限 ${data.staminaPercent}%` : '无体力，按点数计费';
  box.hidden = false;
  box.innerHTML = `<h2>密钥已生成</h2><p class="muted">请马上复制。这枚兑换码不能再次查看密钥，关掉页面前先保存。</p><div class="secret-row"><span>商品</span><strong>${escapeHTML(data.name)}</strong><small>${escapeHTML(tierName(data.tier))} · ${escapeHTML(stamina)} · ${data.points} Anlas · ${escapeHTML(expiresText(data.expiresAt))}</small></div><div class="secret-row"><span>中转地址</span><code id="relay-url">${escapeHTML(data.relayUrl)}</code><button class="button small subtle" type="button" data-copy="relay-url">复制地址</button></div><div class="secret-row"><span>访问密钥</span><code id="relay-key" class="token-display">${escapeHTML(data.token)}</code><button class="button small primary" type="button" data-copy="relay-key">复制密钥</button></div><ol class="redeem-steps"><li>在 Sakura NAI、Launcher 或其他绘图端填写上面的中转地址。</li><li>密钥填写完整的 skr_ 字符串。</li><li>会员小图走体力，其余按点数扣除。</li></ol>`;
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]'); if (!button) return;
  const node = document.getElementById(button.dataset.copy);
  button.disabled = true;
  try { await copy(node.textContent, node); }
  finally { button.disabled = false; }
});

$('#redeem-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, button = $('button[type="submit"]', form), errorNode = $('.form-error', form);
  errorNode.textContent = ''; button.disabled = true;
  try {
    const response = await fetch('/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: new FormData(form).get('code') }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '兑换失败');
    showResult(data);
  } catch (error) { errorNode.textContent = error.message; }
  finally { button.disabled = false; }
});
