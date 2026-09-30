// Local QA fixture: fictional records and a local upstream, never a real account.
import { resolve } from 'node:path';
import { createApp } from '../src/server.mjs';
import { mockUpstream } from '../tests/mock.mjs';
import { passwordHash } from '../src/security.mjs';
const mock = await mockUpstream(); mock.state.paid = false; mock.state.balance = 12840;
const app = createApp({ dataDir:resolve('.preview'), publicOrigin:'http://127.0.0.1:3101', upstreamOrigin:mock.origin });
app.store.set('admin_password',passwordHash('Sakura-Preview-2026'));
const fixtures = [
  {name:'樱花 · 主账户',token:'pst-local-preview',enabled:true,balance:12840,paid:false},
  {name:'花见 · 创作账户',token:'pst-local-preview-two',enabled:true,balance:8640,paid:false},
  {name:'月色 · 备用账户',token:'pst-local-preview-three',enabled:false,balance:4200,paid:true},
];
for (const row of fixtures) {
  mock.state.accounts.set(row.token,{...mock.state,balance:row.balance,paid:row.paid});
  if (!app.store.upstreams().some(u=>u.name===row.name)) app.store.addUpstream(row);
}
if (!app.store.keys().length) {
  const rows=app.store.upstreams();
  const keys = [['小樱的创作空间',3600],['花见 · 插画工作室',8200],['周末的灵感',1400],['个人测试',300]].map(([name,points],i) =>
    app.store.createKey(name,points,i<2 ? {tier:'member',upstreamId:rows[i].id,validDays:30} : {tier:'standard',expiresAt:i===2 ? Date.now()-86400000 : null}));
  app.store.db.prepare('UPDATE keys SET enabled=0 WHERE id=?').run(keys[3].id);
  for (let i=0;i<21;i++) {
    const id=`preview-request-${i}`, kid=keys[i%3].id, cost=[12,26,30,0,8,26,14][i%7];
    const expiry=app.store.key(kid).expires_at;app.store.updateKey(kid,{expiresAt:null});
    app.store.reserve(kid,id,'/ai/generate-image','nai-diffusion-5-full',cost,null,app.store.upstreams()[i%2].id,{mode:i%3===2?'pool':cost?'anlas-pool':'nai5-bound',upstreamEstimate:0});
    app.store.updateKey(kid,{expiresAt:expiry});
    app.store.settle(id,cost,'completed',cost?'按密钥等级本地计价':'会员免费权益，未扣点数',200);
    const timestamp=Date.now()-((20-i)%7)*86400000-i*60000;
    app.store.db.prepare('UPDATE jobs SET created_at=?,finished_at=? WHERE id=?').run(timestamp,timestamp+22000,id);
  }
}
app.server.listen(3101,'127.0.0.1',()=>console.log('本地模拟预览：http://127.0.0.1:3101 · 密码 Sakura-Preview-2026（仅为测试夹具）'));
async function stop(){await app.close();await mock.close();process.exit(0)}process.on('SIGINT',stop);process.on('SIGTERM',stop);
