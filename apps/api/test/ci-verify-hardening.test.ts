import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../../../scripts/ci/verify.sh', import.meta.url));
function verify(extra: Record<string, string> = {}, args = ['--dry-run']) {
  const env = { ...process.env };
  for (const key of ['ALLOW_LIVE_TEST_DB', 'DIRECT_URL', 'SHADOW_DATABASE_URL']) delete env[key];
  Object.assign(
    env,
    {
      DATABASE_URL: 'postgresql://lse_test@127.0.0.1:55439/lse_test',
      REDIS_URL: 'redis://localhost:16389',
    },
    extra,
  );
  return spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
}
test('合法回环测试端点在不同端口dry-run放行，不启动流水线', () => {
  for (const host of ['127.0.0.1', '127.10.2.3', 'localhost', '[::1]']) {
    const r = verify({
      DATABASE_URL: `postgresql://lse_test@${host}:55439/lse_test`,
      REDIS_URL: `redis://${host}:16389`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry-run/);
    assert.doesNotMatch(r.stdout, /\[ci\] install/);
  }
});
test('生产库、错误用户、非回环数据库和Redis均拒绝', () => {
  for (const extra of [
    { DATABASE_URL: 'postgresql://lse_test@127.0.0.1:55439/lse' },
    { DATABASE_URL: 'postgresql://lse@127.0.0.1:55439/lse_test' },
    { DATABASE_URL: 'postgresql://lse_test@192.0.2.1:55439/lse_test' },
    { REDIS_URL: 'redis://example.invalid:16389' },
  ])
    assert.equal(verify(extra).status, 2);
});
test('禁止旁路变量，包括空值；拒绝查询参数、片段与错误协议', () => {
  for (const key of ['ALLOW_LIVE_TEST_DB', 'DIRECT_URL', 'SHADOW_DATABASE_URL']) {
    for (const value of ['1', '']) assert.equal(verify({ [key]: value }).status, 2);
  }
  for (const url of [
    'postgresql://lse_test@localhost:55439/lse_test?host=evil',
    'postgresql://lse_test@localhost:55439/lse_test#x',
    'http://localhost/lse_test',
    'bad',
  ]) {
    assert.equal(verify({ DATABASE_URL: url }).status, 2);
  }
  assert.equal(verify({ REDIS_URL: 'redis://localhost:16389?host=evil' }).status, 2);
  assert.equal(verify({}, ['--unknown']).status, 2);
});
