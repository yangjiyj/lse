import assert from 'node:assert/strict';
import test from 'node:test';

const CURRENT_RULESET = {
  SERVICE_ASSURANCE_NUCLEI_URL: 'http://127.0.0.1:58095',
  SERVICE_ASSURANCE_NUCLEI_ENGINE_DIGEST: `sha256:${'a'.repeat(64)}`,
  SERVICE_ASSURANCE_NUCLEI_RULESET_VERSION: 'lse-rules-2026.08.30.3',
  SERVICE_ASSURANCE_NUCLEI_RULESET_DIGEST: `sha256:${'b'.repeat(64)}`,
  SERVICE_ASSURANCE_NUCLEI_RULESET_UPDATED_AT: '2026-08-30T13:21:26.000Z',
  SERVICE_ASSURANCE_ZAP_URL: 'http://127.0.0.1:58097',
  SERVICE_ASSURANCE_ZAP_ENGINE_DIGEST: `sha256:${'c'.repeat(64)}`,
  SERVICE_ASSURANCE_ZAP_RULESET_VERSION: 'lse-rules-2026.08.30.3',
  SERVICE_ASSURANCE_ZAP_RULESET_DIGEST: `sha256:${'b'.repeat(64)}`,
  SERVICE_ASSURANCE_ZAP_RULESET_UPDATED_AT: '2026-08-30T13:21:26.000Z',
  SERVICE_ASSURANCE_TRIVY_URL: 'http://127.0.0.1:58096',
  SERVICE_ASSURANCE_TRIVY_ENGINE_DIGEST: `sha256:${'d'.repeat(64)}`,
  SERVICE_ASSURANCE_TRIVY_DB_VERSION: 'trivy-db-2026.08.30T070529Z',
  SERVICE_ASSURANCE_TRIVY_DB_DIGEST: `sha256:${'e'.repeat(64)}`,
  SERVICE_ASSURANCE_TRIVY_DB_UPDATED_AT: '2026-08-30T07:05:29.000Z',
};

test('运行态就绪探测按固定 sidecar 健康状态开放三种模式', async () => {
  const readinessModule = (await import('../src/modules/service-assurance/readiness.js')) as Record<
    string,
    unknown
  >;
  const probe = readinessModule.probeServiceAssuranceReadiness as
    | ((
        env: NodeJS.ProcessEnv,
        fetchImpl: typeof fetch,
        now: Date,
      ) => Promise<{
        modes: Array<{ mode: string; ready: boolean; message: string }>;
      }>)
    | undefined;

  assert.equal(typeof probe, 'function');
  const called: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    called.push(String(input));
    return new Response(JSON.stringify({ status: 'ok', ready: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const readiness = await probe!(CURRENT_RULESET, fetchImpl, new Date('2026-08-31T00:00:00.000Z'));

  assert.deepEqual(
    readiness.modes.map(({ mode, ready }) => ({ mode, ready })),
    [
      { mode: 'SAFE', ready: true },
      { mode: 'DEEP', ready: true },
      { mode: 'SBOM', ready: true },
    ],
  );
  assert.deepEqual(
    readiness.modes.map(({ mode, message }) => ({ mode, message })),
    [
      { mode: 'SAFE', message: '安全检查已就绪。' },
      { mode: 'DEEP', message: '授权深度核验已就绪。' },
      { mode: 'SBOM', message: '组件清单核验已就绪。' },
    ],
  );
  assert.deepEqual(called.sort(), [
    'http://127.0.0.1:58095/healthz',
    'http://127.0.0.1:58096/healthz',
    'http://127.0.0.1:58097/healthz',
  ]);
  assert.doesNotMatch(JSON.stringify(readiness), /nuclei|trivy|zap|digest|url|container|path/i);
});

test('运行态探测失败和不完整固定配置只将受影响模式标为未就绪', async () => {
  const readinessModule = (await import('../src/modules/service-assurance/readiness.js')) as Record<
    string,
    unknown
  >;
  const probe = readinessModule.probeServiceAssuranceReadiness as (
    env: NodeJS.ProcessEnv,
    fetchImpl: typeof fetch,
    now: Date,
  ) => Promise<{
    modes: Array<{ mode: string; ready: boolean; message: string }>;
  }>;
  const fetchImpl = (async (input: string | URL | Request) => {
    if (String(input).includes('58097')) {
      return new Response('', { status: 302, headers: { location: 'http://example.invalid' } });
    }
    return new Response(JSON.stringify({ status: 'ok', ready: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const readiness = await probe(
    { ...CURRENT_RULESET, SERVICE_ASSURANCE_TRIVY_DB_DIGEST: '' },
    fetchImpl,
    new Date('2026-08-31T00:00:00.000Z'),
  );

  assert.deepEqual(
    readiness.modes.map(({ mode, ready }) => ({ mode, ready })),
    [
      { mode: 'SAFE', ready: true },
      { mode: 'DEEP', ready: true },
      { mode: 'SBOM', ready: false },
    ],
  );
  assert.match(readiness.modes[1]?.message ?? '', /已就绪/);
  assert.match(readiness.modes[2]?.message ?? '', /尚未启用|未就绪/);
});

test('就绪矩阵按实际目标选择引擎，MCP未提供专项核验', async () => {
  const { probeServiceAssuranceReadiness } =
    await import('../src/modules/service-assurance/readiness.js');
  const { selectServiceAssuranceReadiness } = await import('@lse/shared');
  const fetchImpl = (async (input: string | URL | Request) =>
    new Response(JSON.stringify({ status: 'ok', ready: !String(input).includes('58097') }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const readiness = await probeServiceAssuranceReadiness(
    CURRENT_RULESET,
    fetchImpl,
    new Date('2026-08-31T00:00:00.000Z'),
  );
  for (const mode of ['SAFE', 'DEEP'] as const) {
    assert.equal(selectServiceAssuranceReadiness(readiness, mode, 'ENDPOINT')?.ready, true);
    assert.equal(selectServiceAssuranceReadiness(readiness, mode, 'OPENAPI')?.ready, false);
    assert.equal(selectServiceAssuranceReadiness(readiness, mode, 'MCP')?.ready, false);
  }
});

test('OpenAPI 的共享规则基线不一致时不可开始，普通接口不受 ZAP 配置漂移影响', async () => {
  const { probeServiceAssuranceReadiness } =
    await import('../src/modules/service-assurance/readiness.js');
  const { selectServiceAssuranceReadiness } = await import('@lse/shared');
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ status: 'ok', ready: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const readiness = await probeServiceAssuranceReadiness(
    { ...CURRENT_RULESET, SERVICE_ASSURANCE_ZAP_RULESET_DIGEST: `sha256:${'f'.repeat(64)}` },
    fetchImpl,
    new Date('2026-08-31T00:00:00.000Z'),
  );
  assert.equal(selectServiceAssuranceReadiness(readiness, 'SAFE', 'OPENAPI')?.ready, false);
  assert.equal(selectServiceAssuranceReadiness(readiness, 'DEEP', 'ENDPOINT')?.ready, true);
});
