import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
for (const dir of ['src', 'public', 'scripts', 'tests']) for (const file of readdirSync(dir)) {
  if (!/\.(m?js)$/.test(file)) continue;
  const result = spawnSync(process.execPath, ['--check', join(dir, file)], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}
console.log('所有 JavaScript 文件语法检查通过。');
