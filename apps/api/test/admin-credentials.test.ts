import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdminCredentials, DEV_DEFAULT_PASSWORD } from '../src/lib/admin-credentials.js';

// ② 默认凭证生产环境 fail-fast：内置示例口令禁止进生产，且明文口令绝不外泄。

test('生产环境未显式设置 ADMIN_PASSWORD 时必须 fail-fast（抛异常）', () => {
  assert.throws(() => resolveAdminCredentials({ NODE_ENV: 'production' }), /ADMIN_PASSWORD/);
});

test('生产环境使用内置示例口令 Admin@12345 时必须 fail-fast', () => {
  assert.throws(
    () => resolveAdminCredentials({ NODE_ENV: 'production', ADMIN_PASSWORD: DEV_DEFAULT_PASSWORD }),
    /生产/,
  );
});

test('生产环境设置强口令时正常返回，且 passwordSource=env', () => {
  const strong = ['S7r0ng', 'Pr0d', 'Pass', '9z!'].join('-');
  const cred = resolveAdminCredentials({ NODE_ENV: 'production', ADMIN_PASSWORD: strong });
  assert.equal(cred.username, 'admin');
  assert.equal(cred.password, strong);
  assert.equal(cred.displayName, '超级管理员');
  assert.equal(cred.passwordSource, 'env');
});

test('非生产未设置口令时回退到开发默认口令，passwordSource=dev-default', () => {
  const cred = resolveAdminCredentials({ NODE_ENV: 'development' });
  assert.equal(cred.password, DEV_DEFAULT_PASSWORD);
  assert.equal(cred.passwordSource, 'dev-default');
});

test('非生产显式设置口令时优先使用 env 口令', () => {
  const custom = 'dev-custom-pass';
  const cred = resolveAdminCredentials({ NODE_ENV: 'test', ADMIN_PASSWORD: custom });
  assert.equal(cred.password, custom);
  assert.equal(cred.passwordSource, 'env');
});

test('username 与 displayName 支持 env 覆盖', () => {
  const cred = resolveAdminCredentials({
    NODE_ENV: 'development',
    ADMIN_USERNAME: 'root',
    ADMIN_DISPLAY_NAME: '平台管理员',
  });
  assert.equal(cred.username, 'root');
  assert.equal(cred.displayName, '平台管理员');
});

test('NODE_ENV 缺省（undefined）视为非生产，不 fail-fast', () => {
  const cred = resolveAdminCredentials({});
  assert.equal(cred.password, DEV_DEFAULT_PASSWORD);
  assert.equal(cred.passwordSource, 'dev-default');
});

test('NODE_ENV=Production（首字母大写）视为生产环境，缺密码时抛出', () => {
  assert.throws(() => resolveAdminCredentials({ NODE_ENV: 'Production' }), /生产环境/);
});

test('NODE_ENV=prod（别名）视为生产环境，缺密码时抛出', () => {
  assert.throws(() => resolveAdminCredentials({ NODE_ENV: 'prod' }), /生产环境/);
});
