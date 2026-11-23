import test from 'node:test';
import assert from 'node:assert/strict';

import { assertSafeTestDatabaseUrl, assertTestEntryEnvironment } from '../src/test-db-safety.js';

test('拒绝测试套件连接生产数据库，除非显式放行', () => {
  assert.throws(
    () => assertSafeTestDatabaseUrl('postgresql://user:pass@prod-db:5432/lse', {}),
    /refusing live database/i,
  );
  assert.throws(
    () => assertSafeTestDatabaseUrl('postgresql://user:pass@127.0.0.1:5432/lse', {}),
    /refusing live database/i,
  );
});

test('允许本地测试数据库和显式放行的演练环境', () => {
  assert.doesNotThrow(() =>
    assertSafeTestDatabaseUrl('postgresql://user:pass@127.0.0.1:5432/lse_test', {}),
  );
  assert.doesNotThrow(() =>
    assertSafeTestDatabaseUrl('postgresql://user:pass@prod-db:5432/lse', {
      ALLOW_LIVE_TEST_DB: '1',
    }),
  );
});

test('损坏的数据库 URL 也按拒绝处理', () => {
  assert.throws(() => assertSafeTestDatabaseUrl('not-a-url', {}), /refusing live database/i);
});

test('测试入口：必须显式设置 LSE_TEST=1，与 DATABASE_URL 是什么无关', () => {
  const url = 'postgresql://u:p@127.0.0.1:55434/lse_test';
  for (const env of [{}, { LSE_TEST: '0' }, { LSE_TEST: 'true' }, { LSE_TEST: '' }]) {
    assert.throws(() => assertTestEntryEnvironment(env), /LSE_TEST=1 is required/);
  }
  assert.doesNotThrow(() => assertTestEntryEnvironment({ LSE_TEST: '1' }));
  assert.ok(url);
});

test('测试入口：通过本层后，库地址白名单仍然生效（主机或库名不合规照样拒绝）', () => {
  assert.doesNotThrow(() => assertTestEntryEnvironment({ LSE_TEST: '1' }));
  assert.throws(
    () => assertSafeTestDatabaseUrl('postgresql://u:p@db.prod.internal:5432/lse', {}),
    /refusing live database/i,
  );
});
