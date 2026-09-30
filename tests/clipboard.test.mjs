import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const tokenText = 'skr_clipboard-test-key';

async function fixture({ clipboard, modal = true, legacy = true } = {}) {
  const events = {}, fields = [], copied = [], notifications = [], parents = [];
  const oldRange = { cloneRange: () => oldRange };
  const selection = {
    ranges: [oldRange], get rangeCount() { return this.ranges.length; },
    getRangeAt(i) { return this.ranges[i]; }, removeAllRanges() { this.ranges = []; },
    addRange(range) { this.ranges.push(range); },
  };
  const document = {
    activeElement: null, getSelection: () => selection,
    addEventListener(type, handler) { events[type] = handler; },
    createRange: () => ({ selectNodeContents(source) { this.source = source; } }),
    createElement(tag) {
      const node = {
        tag, style: {}, classList: { add() {}, remove() {} },
        focus() { if (!modal || this.parent === dialog || this === button) document.activeElement = this; },
        select() { selection.removeAllRanges(); },
        setSelectionRange(start, end) { this.start = start; this.end = end; },
        remove() { this.removed = true; },
      };
      if (tag === 'textarea') fields.push(node);
      return node;
    },
    execCommand(command) {
      assert.equal(command, 'copy');
      const field = fields.at(-1);
      assert.equal(document.activeElement, field, '复制字段必须能在当前弹窗内获得焦点');
      assert.equal(field.readOnly, true);
      assert.equal(field.start, 0); assert.equal(field.end, field.value.length);
      if (legacy instanceof Error) throw legacy;
      if (legacy) copied.push(field.value);
      return legacy;
    },
  };
  const parent = name => ({ append(node) { node.parent = this; parents.push(name); } });
  document.body = parent('body');
  const dialog = { ...parent('dialog'), open: modal, addEventListener() {} };
  const token = { textContent: tokenText };
  const address = { textContent: 'http://relay.test:3100' };
  const button = {
    ...document.createElement('button'), dataset: { action: 'copy-key' },
    closest() { return this; },
  };
  document.activeElement = button;
  document.querySelector = selector => ({
    '#app': {}, '#dialog': dialog, '#new-token': token, '.address-field code': address,
    '#toasts': { append(node) { notifications.push({ text: node.textContent, bad: node.className.includes('bad') }); } },
  })[selector];
  const context = createContext({
    document, navigator: { clipboard }, window: { addEventListener() {} }, location: { hash: '' },
    fetch: async () => ({ ok: true, json: async () => ({ initialized: true, loggedIn: false }) }),
    setTimeout() {},
  });
  runInContext(appSource, context);
  await Promise.resolve();
  return { fields, copied, notifications, parents, selection, oldRange, button, token, address, document,
    click: action => { button.dataset.action = action; return events.click({ target: button }); },
    setRelayUrl: () => runInContext(`state.data = { relayUrl: 'http://relay.test:3100' }`, context),
  };
}

test('复制密钥优先使用 Clipboard API，并在成功后提示', async () => {
  const written = [];
  const f = await fixture({ clipboard: { writeText: async text => written.push(text) } });
  await f.click('copy-key');
  assert.deepEqual(written, [tokenText]); assert.equal(f.fields.length, 0);
  assert.deepEqual(f.notifications, [{ text: '已复制到剪贴板', bad: false }]);
  assert.equal(f.button.disabled, false);
});

for (const [name, clipboard] of [
  ['没有 Clipboard API', undefined],
  ['没有 writeText 方法', {}],
  ['剪贴板权限被拒绝', { writeText: async () => { throw new Error('NotAllowedError'); } }],
]) {
  test(`${name}时在密钥弹窗内兼容复制，并清理临时字段`, async () => {
    const f = await fixture({ clipboard });
    await f.click('copy-key');
    assert.deepEqual(f.copied, [tokenText]); assert.deepEqual(f.parents, ['dialog']);
    assert.equal(f.fields[0].removed, true); assert.equal(f.document.activeElement, f.button);
    assert.deepEqual(f.selection.ranges, [f.oldRange]);
    assert.deepEqual(f.notifications, [{ text: '已复制到剪贴板', bad: false }]);
    assert.equal(f.button.disabled, false);
  });
}

test('复制中转地址在没有弹窗的 HTTP 页面使用兼容方式', async () => {
  const f = await fixture({ modal: false }); f.setRelayUrl();
  await f.click('copy-url');
  assert.deepEqual(f.copied, ['http://relay.test:3100']); assert.deepEqual(f.parents, ['body']);
  assert.equal(f.fields[0].removed, true); assert.equal(f.button.disabled, false);
});

for (const [name, legacy] of [['返回失败', false], ['抛出异常', new Error('copy blocked')]]) {
  test(`两种复制方式均失败且兼容接口${name}时，选中密钥并提示手动复制`, async () => {
    const f = await fixture({ clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } }, legacy });
    await f.click('copy-key');
    assert.deepEqual(f.copied, []); assert.equal(f.fields[0].removed, true);
    assert.equal(f.selection.ranges[0].source, f.token);
    assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].bad, true);
    assert.match(f.notifications[0].text, /已选中文本.*Ctrl\+C/);
    assert.equal(f.button.disabled, false);
  });
}

test('中转地址自动复制失败时同样选中地址供手动复制', async () => {
  const f = await fixture({ modal: false, legacy: false }); f.setRelayUrl();
  await f.click('copy-url');
  assert.equal(f.selection.ranges[0].source, f.address);
  assert.equal(f.notifications[0].bad, true); assert.match(f.notifications[0].text, /长按复制/);
  assert.equal(f.button.disabled, false);
});
