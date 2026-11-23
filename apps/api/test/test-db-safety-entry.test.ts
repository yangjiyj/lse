import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 真实入口回归：用子进程按 package.json 的 test 脚本同样的方式加载 test-db-safety-preload.ts，
// 数据库地址一律用不可达的假地址（127.0.0.1:1），测试本身是个空用例，全程不会连接任何数据库。
const apiRoot = resolve(import.meta.dirname, '..');
const preload = join(apiRoot, 'test', 'test-db-safety-preload.ts');
const SAFE_URL = 'postgresql://x:x@127.0.0.1:1/x_test';

// NODE_TEST_CONTEXT 由外层 node:test 注入；子进程继承它会按“子测试”方式运行，失败不反映到退出码，必须去掉。
function runEntry(env: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), 'lse-gate-'));
  try {
    const file = join(dir, 'noop.test.mjs');
    writeFileSync(file, "import test from 'node:test'; test('noop', () => {});\n");
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(LSE_TEST|LSE_TEST_ALLOW_ENV_FILE|DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|ALLOW_LIVE_TEST_DB|NODE_TEST_CONTEXT)$/.test(k)) clean[k] = v;
    }
    for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', preload, '--test', file], {
      cwd: apiRoot,
      env: clean,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('入口：没设 LSE_TEST=1 一律拒绝，即使 DATABASE_URL 是合规的测试库', () => {
  const withUrl = runEntry({ DATABASE_URL: SAFE_URL });
  assert.notEqual(withUrl.status, 0);
  assert.match(withUrl.output, /LSE_TEST=1 is required/);
  const bare = runEntry({});
  assert.notEqual(bare.status, 0);
  assert.match(bare.output, /LSE_TEST=1 is required/);
});

test('入口：LSE_TEST=1 加合规的显式测试库地址，放行', () => {
  const result = runEntry({ LSE_TEST: '1', DATABASE_URL: SAFE_URL });
  assert.equal(result.status, 0, result.output);
});

test('入口：通过第一层后，主机或库名不合规仍由白名单拒绝', () => {
  const host = runEntry({ LSE_TEST: '1', DATABASE_URL: 'postgresql://x:x@db.prod.internal:5432/x_test' });
  assert.notEqual(host.status, 0);
  assert.match(host.output, /refusing live database/);
  const name = runEntry({ LSE_TEST: '1', DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/lse' });
  assert.notEqual(name.status, 0);
  assert.match(name.output, /refusing live database/);
});
