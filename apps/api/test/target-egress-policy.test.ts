import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TargetEgressError,
  assertTargetUrlAllowed,
  fetchTarget,
  readResponseBodyLimited,
  resolveTargetEgressPolicy,
} from '../src/lib/target-egress-policy.js';

test('未配置目标出站策略时默认允许公网 HTTP/S', async () => {
  const allowed = await assertTargetUrlAllowed('https://api.example.com/v1', {
    context: { tenantId: 'tenant-a', projectId: 'project-a' },
    env: {},
  });
  assert.equal(allowed.origin, 'https://api.example.com');
});

test('未配置目标出站策略时默认允许内网 HTTP/S', async () => {
  const allowed = await assertTargetUrlAllowed('http://100.64.0.10:8080/v1', {
    context: { tenantId: 'tenant-a', projectId: 'project-a' },
    env: {},
  });
  assert.equal(allowed.origin, 'http://100.64.0.10:8080');
});

test('目标 URL 仅允许 http/https，禁止 file、ftp 和凭据 URL', async () => {
  const env = { LSE_TARGET_EGRESS_ALLOWLIST: 'https://api.example.com' };
  for (const value of [
    'file:///etc/passwd',
    'ftp://api.example.com/model',
    'https://user:pass@api.example.com/model',
  ]) {
    await assert.rejects(
      () => assertTargetUrlAllowed(value, { context: { tenantId: 't', projectId: 'p' }, env }),
      (error: unknown) =>
        error instanceof TargetEgressError && error.code === 'TARGET_EGRESS_URL_INVALID',
    );
  }
});

test('未登记的公网 origin 和未显式授权的 loopback 都被拒绝', async () => {
  const env = { LSE_TARGET_EGRESS_ALLOWLIST: 'https://api.example.com' };
  await assert.rejects(
    () =>
      assertTargetUrlAllowed('https://evil.example.com/model', {
        context: { tenantId: 'tenant-a', projectId: 'project-a' },
        env,
      }),
    (error: unknown) =>
      error instanceof TargetEgressError && error.code === 'TARGET_EGRESS_TARGET_NOT_ALLOWED',
  );
  await assert.rejects(
    () =>
      assertTargetUrlAllowed('http://127.0.0.1:8080/v1', {
        context: { tenantId: 'tenant-a', projectId: 'project-a' },
        env,
      }),
    (error: unknown) =>
      error instanceof TargetEgressError && error.code === 'TARGET_EGRESS_TARGET_NOT_ALLOWED',
  );
});

test('loopback 模型可在 tenant/project policy 中显式登记', async () => {
  const env = {
    LSE_TARGET_EGRESS_POLICIES: JSON.stringify({
      'tenant-a/project-a': { allowlist: ['http://127.0.0.1:18080'], allowPrivateNetworks: true },
    }),
  };
  const allowed = await assertTargetUrlAllowed('http://127.0.0.1:18080/v1', {
    context: { tenantId: 'tenant-a', projectId: 'project-a' },
    env,
  });
  assert.equal(allowed.origin, 'http://127.0.0.1:18080');
  await assert.rejects(
    () =>
      assertTargetUrlAllowed('http://127.0.0.1:18081/v1', {
        context: { tenantId: 'tenant-a', projectId: 'project-a' },
        env,
      }),
    (error: unknown) =>
      error instanceof TargetEgressError && error.code === 'TARGET_EGRESS_TARGET_NOT_ALLOWED',
  );
});

test('tenant/project 不匹配时不回退到其他项目的 allowlist', () => {
  const env = {
    LSE_TARGET_EGRESS_POLICIES: JSON.stringify({
      'tenant-a/project-a': ['https://api.example.com'],
    }),
  };
  assert.deepEqual(
    resolveTargetEgressPolicy({ tenantId: 'tenant-a', projectId: 'project-b' }, env),
    { allowlist: [], allowPrivateNetworks: false },
  );
});

test('即使 IP literal 在 allowlist 中，私网仍需显式开启内网策略', async () => {
  const env = {
    LSE_TARGET_EGRESS_POLICIES: JSON.stringify({
      'tenant-a/project-a': ['http://127.0.0.1:18080'],
    }),
  };
  await assert.rejects(
    () =>
      assertTargetUrlAllowed('http://127.0.0.1:18080/v1', {
        context: { tenantId: 'tenant-a', projectId: 'project-a' },
        env,
      }),
    (error: unknown) =>
      error instanceof TargetEgressError && error.code === 'TARGET_EGRESS_PRIVATE_ADDRESS',
  );
});

test('解析后的私网地址默认拒绝，显式 allowPrivateNetworks 才能放行内网 DNS', async () => {
  const env = {
    LSE_TARGET_EGRESS_POLICIES: JSON.stringify({
      'tenant-a/project-a': {
        allowlist: ['http://model.internal:8080'],
        allowPrivateNetworks: false,
      },
      'tenant-a/project-b': {
        allowlist: ['http://model.internal:8080'],
        allowPrivateNetworks: true,
      },
    }),
  };
  const lookup = async () => [{ address: '127.0.0.1', family: 4 as const }];
  await assert.rejects(
    () =>
      assertTargetUrlAllowed('http://model.internal:8080/v1', {
        context: { tenantId: 'tenant-a', projectId: 'project-a' },
        env,
        lookup,
      }),
    (error: unknown) =>
      error instanceof TargetEgressError && error.code === 'TARGET_EGRESS_PRIVATE_ADDRESS',
  );
  await assertTargetUrlAllowed('http://model.internal:8080/v1', {
    context: { tenantId: 'tenant-a', projectId: 'project-b' },
    env,
    lookup,
  });
});

test('fetchTarget 禁止重定向且不会把请求交给第二跳', async () => {
  const originalFetch = globalThis.fetch;
  let seenInit: RequestInit | undefined;
  globalThis.fetch = (async (_url, init) => {
    seenInit = init;
    return new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        fetchTarget(
          'http://127.0.0.1:18080/v1',
          { method: 'POST' },
          {
            env: {
              LSE_TARGET_EGRESS_POLICIES: JSON.stringify({
                'tenant-a/project-a': {
                  allowlist: ['http://127.0.0.1:18080'],
                  allowPrivateNetworks: true,
                },
              }),
            },
            context: { tenantId: 'tenant-a', projectId: 'project-a' },
          },
        ),
      (error: unknown) =>
        error instanceof TargetEgressError && error.code === 'TARGET_EGRESS_REDIRECT_BLOCKED',
    );
    assert.equal(seenInit?.redirect, 'manual');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchTarget 默认有超时，不会无限等待目标', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        fetchTarget(
          'http://127.0.0.1:18080/v1',
          { method: 'POST' },
          {
            timeoutMs: 5,
            env: {
              LSE_TARGET_EGRESS_POLICIES: JSON.stringify({
                'tenant-a/project-a': {
                  allowlist: ['http://127.0.0.1:18080'],
                  allowPrivateNetworks: true,
                },
              }),
            },
            context: { tenantId: 'tenant-a', projectId: 'project-a' },
          },
        ),
      (error: unknown) => (error as Error).name === 'AbortError',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('响应体读取有大小预算', async () => {
  const response = new Response('0123456789');
  await assert.rejects(
    () => readResponseBodyLimited(response, 5),
    (error: unknown) =>
      error instanceof TargetEgressError && error.code === 'TARGET_RESPONSE_TOO_LARGE',
  );
});
