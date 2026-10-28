import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { Store } from '../src/db.mjs';

test('旧上游迁移为空白元数据，保存、启停与重启保留备注，允许清空', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-upstream-metadata-'));
  let store = new Store(directory);
  try {
    const id = store.addUpstream({ name: '旧上游', token: 'pst-test-metadata' });
    store.db.exec('ALTER TABLE upstreams DROP COLUMN note');
    store.close(); store = new Store(directory);
    assert.equal(store.upstream(id).note, '');
    store.updateUpstream(id, { note: '第一行\n第二行', enabled: true });
    store.updateUpstream(id, { enabled: false });
    store.close(); store = new Store(directory);
    assert.equal(store.upstreams()[0].note, '第一行\n第二行');
    assert.equal(store.upstreamToken(id), 'pst-test-metadata');
    store.updateUpstream(id, { note: '', enabled: true });
    assert.equal(store.upstream(id).note, '');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('上游数值双向排序，未知值始终置底，同值稳定，显示文本安全转义', () => {
  const context = createContext({});
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  runInContext(source.slice(0, source.indexOf("document.addEventListener('click'")), context);
  runInContext(`state.data = { upstreams: [1,2,3,4].map(id => ({ id, name: '上游'+id, note: '<img onerror="alert(1)">', enabled: true })) };
    state.quota = { upstreams: [{ id: 1, ok: false }, ...[2,3,4].map(id => ({ id, ok: true, account: { expiresAt: id === 2 ? 100 : 20, relay: { balance: id === 2 ? 100 : 20 }, usage: { percent: id === 2 ? 100 : 20 } } }))] };`, context);
  for (const key of ['expires', 'points', 'stamina']) {
    for (const [direction, expected] of [['asc', [3,4,2,1]], ['desc', [2,3,4,1]]]) {
      runInContext(`state.upstreamSort = ${JSON.stringify({ key, direction })}`, context);
      assert.deepEqual(Array.from(context.sortedUpstreams(), row => row.id), expected);
    }
  }
  const html = context.upstreamTable();
  assert.match(html, /aria-sort="descending"/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|<script/);
  assert.doesNotMatch(html, /data-sort="(?:name|queued)"/);
  runInContext('state.data.upstreams[1].enabled = false; state.data.upstreams[2].enabled = false;', context);
  for (const [direction, expected] of [['asc', [4,1,3,2]], ['desc', [4,1,2,3]]]) {
    runInContext(`state.upstreamSort = { key: 'points', direction: '${direction}' }`, context);
    assert.deepEqual(Array.from(context.sortedUpstreams(), row => row.id), expected);
  }
  const grouped = context.upstreamTable();
  assert.ok(grouped.indexOf('上游1') < grouped.indexOf('upstream-group-disabled'));
  assert.ok(grouped.indexOf('上游2') > grouped.indexOf('upstream-group-disabled'));
  runInContext('state.data.upstreams.forEach(row => row.enabled = false)', context);
  assert.doesNotMatch(context.upstreamTable(), />已启用</);
  assert.match(context.upstreamTable(), /upstream-group-disabled/);
  assert.deepEqual(Array.from(runInContext('state.data.upstreams', context), row => row.id), [1,2,3,4]);
});
