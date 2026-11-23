import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ScannerScopeError,
  assertPinnedConnection,
  authorizeRedirect,
  previewScannerTarget,
  resolveAndAuthorizeTarget,
  resolveScannerScopePolicy,
  type ScannerDnsResolver,
  type ScannerScopePolicy,
} from '../src/lib/scanner-scope.js';

function resolver(
  records: Record<string, Array<{ address: string; ttl?: number }>>,
): ScannerDnsResolver {
  return async (hostname) => ({ records: records[hostname] ?? [] });
}

const publicPolicy: ScannerScopePolicy = {
  ref: 'public-api',
  origins: ['https://api.example.test'],
  cidrs: ['93.184.216.0/24'],
  allowPrivate: false,
  allowPublic: true,
};

const privatePolicy: ScannerScopePolicy = {
  ref: 'private-lab',
  origins: ['http://lab.internal:8080'],
  cidrs: ['10.42.0.0/16'],
  allowPrivate: true,
  allowPublic: false,
};

async function expectScopeError(
  action: () => Promise<unknown> | unknown,
  code: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    return error instanceof ScannerScopeError && error.code === code;
  });
}

test('只允许服务端登记的 HTTP/S origin 与 CIDR', async () => {
  const target = await resolveAndAuthorizeTarget(
    'https://api.example.test/v1/models',
    publicPolicy,
    {
      resolve: resolver({ 'api.example.test': [{ address: '93.184.216.34', ttl: 60 }] }),
    },
  );

  assert.equal(target.hostname, 'api.example.test');
  assert.deepEqual(target.addresses, ['93.184.216.34']);
  assert.equal(target.pinnedAddress, '93.184.216.34');

  await expectScopeError(
    () =>
      resolveAndAuthorizeTarget('https://other.example.test/v1', publicPolicy, {
        resolve: resolver({ 'other.example.test': [{ address: '93.184.216.34', ttl: 60 }] }),
      }),
    'SCANNER_SCOPE_ORIGIN_DENIED',
  );
  await expectScopeError(
    () =>
      resolveAndAuthorizeTarget('https://api.example.test/v1', publicPolicy, {
        resolve: resolver({ 'api.example.test': [{ address: '93.184.217.1', ttl: 60 }] }),
      }),
    'SCANNER_SCOPE_CIDR_DENIED',
  );
});

test('管理员预览目标时只返回可用于精确授权的 origin 与主机 CIDR', async () => {
  const preview = await previewScannerTarget('https://api.example.test/v1/models', {
    resolve: resolver({
      'api.example.test': [
        { address: '93.184.216.34', ttl: 60 },
        { address: '2001:4860:4860::8888', ttl: 60 },
      ],
    }),
  });
  assert.equal(preview.origin, 'https://api.example.test');
  assert.deepEqual(preview.addresses, ['93.184.216.34', '2001:4860:4860:0:0:0:0:8888']);
  assert.deepEqual(preview.suggestedCidrs, ['93.184.216.34/32', '2001:4860:4860:0:0:0:0:8888/128']);
  assert.equal(preview.allowPublic, true);
  assert.equal(preview.allowPrivate, false);
});

test('非法协议、URL 凭据、片段和异常端口在 DNS 前被拒绝', async () => {
  for (const value of [
    'file:///etc/passwd',
    'gopher://api.example.test/',
    'https://user:pass@api.example.test/',
    'https://api.example.test/path#secret',
    'https://api.example.test/path?access_token=SENTINEL_NEVER_STORE',
    'https://api.example.test:99999/',
  ]) {
    await expectScopeError(
      () => resolveAndAuthorizeTarget(value, publicPolicy),
      'SCANNER_SCOPE_URL_INVALID',
    );
  }
});

test('云元数据与特殊 IPv4/IPv6 表示不能被显式 CIDR 放行', async () => {
  const metadataPolicy: ScannerScopePolicy = {
    ref: 'bad-policy',
    origins: ['http://169.254.169.254'],
    cidrs: ['0.0.0.0/0', '::/0'],
    allowPrivate: true,
    allowPublic: true,
  };

  for (const value of [
    'http://169.254.169.254/latest/meta-data',
    'http://2852039166/latest/meta-data',
    'http://0251.0376.0251.0376/latest/meta-data',
    'http://0xa9.0xfe.0xa9.0xfe/latest/meta-data',
    'http://[::ffff:169.254.169.254]/latest/meta-data',
  ]) {
    await expectScopeError(
      () => resolveAndAuthorizeTarget(value, metadataPolicy),
      'SCANNER_SCOPE_ADDRESS_DENIED',
    );
  }

  const metadataDnsPolicy = { ...metadataPolicy, origins: ['http://metadata.google.internal'] };
  await expectScopeError(
    () =>
      resolveAndAuthorizeTarget(
        'http://metadata.google.internal/computeMetadata/v1',
        metadataDnsPolicy,
        {
          resolve: resolver({
            'metadata.google.internal': [{ address: '93.184.216.34', ttl: 60 }],
          }),
        },
      ),
    'SCANNER_SCOPE_ADDRESS_DENIED',
  );
});

test('任一 DNS 结果越界、TTL 为零或解析为空都失败关闭', async () => {
  await expectScopeError(
    () =>
      resolveAndAuthorizeTarget('https://api.example.test/v1', publicPolicy, {
        resolve: resolver({
          'api.example.test': [
            { address: '93.184.216.34', ttl: 60 },
            { address: '10.42.0.9', ttl: 60 },
          ],
        }),
      }),
    'SCANNER_SCOPE_ADDRESS_DENIED',
  );
  await expectScopeError(
    () =>
      resolveAndAuthorizeTarget('https://api.example.test/v1', publicPolicy, {
        resolve: resolver({ 'api.example.test': [{ address: '93.184.216.34', ttl: 0 }] }),
      }),
    'SCANNER_SCOPE_DNS_REBINDING',
  );
  await expectScopeError(
    () =>
      resolveAndAuthorizeTarget('https://api.example.test/v1', publicPolicy, {
        resolve: resolver({ 'api.example.test': [] }),
      }),
    'SCANNER_SCOPE_DNS_FAILED',
  );
});

test('内网地址必须同时满足私网授权和精确 CIDR', async () => {
  const target = await resolveAndAuthorizeTarget(
    'http://lab.internal:8080/openapi.json',
    privatePolicy,
    {
      resolve: resolver({ 'lab.internal': [{ address: '10.42.7.9', ttl: 30 }] }),
    },
  );
  assert.equal(target.pinnedAddress, '10.42.7.9');

  await expectScopeError(
    () =>
      resolveAndAuthorizeTarget('http://lab.internal:8080/openapi.json', privatePolicy, {
        resolve: resolver({ 'lab.internal': [{ address: '10.43.0.1', ttl: 30 }] }),
      }),
    'SCANNER_SCOPE_CIDR_DENIED',
  );
  await expectScopeError(
    () =>
      resolveAndAuthorizeTarget(
        'http://lab.internal:8080/openapi.json',
        { ...privatePolicy, allowPrivate: false },
        { resolve: resolver({ 'lab.internal': [{ address: '10.42.7.9', ttl: 30 }] }) },
      ),
    'SCANNER_SCOPE_ADDRESS_DENIED',
  );
});

test('每次重定向重新校验 origin 与解析 IP', async () => {
  const first = await resolveAndAuthorizeTarget('https://api.example.test/start', publicPolicy, {
    resolve: resolver({ 'api.example.test': [{ address: '93.184.216.34', ttl: 60 }] }),
  });
  const sameOrigin = await authorizeRedirect(first, '/next', publicPolicy, {
    resolve: resolver({ 'api.example.test': [{ address: '93.184.216.35', ttl: 60 }] }),
  });
  assert.equal(sameOrigin.url.pathname, '/next');
  assert.equal(sameOrigin.pinnedAddress, '93.184.216.35');

  await expectScopeError(
    () =>
      authorizeRedirect(first, 'https://evil.example.test/next', publicPolicy, {
        resolve: resolver({ 'evil.example.test': [{ address: '93.184.216.36', ttl: 60 }] }),
      }),
    'SCANNER_SCOPE_ORIGIN_DENIED',
  );
  await expectScopeError(
    () =>
      authorizeRedirect(first, 'https://api.example.test/next', publicPolicy, {
        resolve: resolver({ 'api.example.test': [{ address: '127.0.0.1', ttl: 60 }] }),
      }),
    'SCANNER_SCOPE_ADDRESS_DENIED',
  );
});

test('连接前实际 IP 必须等于锁定 IP', async () => {
  const target = await resolveAndAuthorizeTarget('https://api.example.test/v1', publicPolicy, {
    resolve: resolver({ 'api.example.test': [{ address: '93.184.216.34', ttl: 60 }] }),
  });
  assert.doesNotThrow(() => assertPinnedConnection(target, '93.184.216.34'));
  assert.throws(
    () => assertPinnedConnection(target, '93.184.216.35'),
    (error: unknown) =>
      error instanceof ScannerScopeError && error.code === 'SCANNER_SCOPE_DNS_REBINDING',
  );
});

test('范围策略只能从服务端映射解析且非法配置失败关闭', () => {
  const env = {
    SERVICE_ASSURANCE_SCOPE_POLICIES: JSON.stringify({
      'public-api': publicPolicy,
    }),
  };
  assert.deepEqual(resolveScannerScopePolicy('public-api', env), publicPolicy);
  assert.throws(
    () => resolveScannerScopePolicy('missing', env),
    (error: unknown) =>
      error instanceof ScannerScopeError && error.code === 'SCANNER_SCOPE_POLICY_NOT_FOUND',
  );
  assert.throws(
    () =>
      resolveScannerScopePolicy('bad', {
        SERVICE_ASSURANCE_SCOPE_POLICIES: JSON.stringify({ bad: { origins: ['*'] } }),
      }),
    (error: unknown) =>
      error instanceof ScannerScopeError && error.code === 'SCANNER_SCOPE_POLICY_INVALID',
  );
  assert.throws(
    () =>
      resolveScannerScopePolicy('global', {
        SERVICE_ASSURANCE_SCOPE_POLICIES: JSON.stringify({
          global: {
            ref: 'global',
            origins: ['https://api.example.test'],
            cidrs: ['0.0.0.0/0'],
            allowPrivate: true,
            allowPublic: true,
          },
        }),
      }),
    (error: unknown) =>
      error instanceof ScannerScopeError && error.code === 'SCANNER_SCOPE_POLICY_INVALID',
  );
});
