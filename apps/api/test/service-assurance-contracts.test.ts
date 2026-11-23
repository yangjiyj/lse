import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SERVICE_ASSURANCE_REQUEST_BUDGET,
  serviceAssuranceCreateBodySchema,
} from '../src/modules/service-assurance/contracts.js';
import { buildServiceAssuranceReadiness } from '../src/modules/service-assurance/readiness.js';
import {
  buildNucleiScanRequest,
  parseNucleiScanResponse,
} from '../src/modules/service-assurance/adapters/nuclei.js';

const validCreateBody = {
  taskId: '00000000-0000-4000-8000-000000000001',
  mode: 'SAFE',
  targetKind: 'ENDPOINT',
  targetName: '受控测试服务',
  targetUrl: 'https://api.example.test/v1',
  scopePolicyRef: 'customer-lab',
  authorizationConfirmed: false,
};

test('创建契约只接受客户字段并拒绝扫描器控制参数和明文密钥', () => {
  assert.equal(serviceAssuranceCreateBodySchema.parse(validCreateBody).mode, 'SAFE');

  for (const forbiddenField of [
    'templatePath',
    'command',
    'concurrency',
    'timeout',
    'allowedHosts',
    'apiKey',
  ]) {
    assert.throws(() =>
      serviceAssuranceCreateBodySchema.parse({
        ...validCreateBody,
        [forbiddenField]: forbiddenField === 'apiKey' ? 'SENTINEL_SECRET_NEVER_STORE' : 'x',
      }),
    );
  }
});

test('创建契约拒绝带 URL 凭据、片段和模式目标不匹配', () => {
  assert.throws(() =>
    serviceAssuranceCreateBodySchema.parse({
      ...validCreateBody,
      targetUrl: 'https://user:pass@example.test/v1',
    }),
  );
  assert.throws(() =>
    serviceAssuranceCreateBodySchema.parse({
      ...validCreateBody,
      targetUrl: 'https://api.example.test/v1#fragment',
    }),
  );
  for (const query of [
    'api_key=SENTINEL_NEVER_STORE',
    'access_token=SENTINEL_NEVER_STORE',
    'signature=SENTINEL_NEVER_STORE',
  ]) {
    assert.throws(() =>
      serviceAssuranceCreateBodySchema.parse({
        ...validCreateBody,
        targetUrl: `https://api.example.test/v1?${query}`,
      }),
    );
  }
  assert.throws(() =>
    serviceAssuranceCreateBodySchema.parse({
      ...validCreateBody,
      mode: 'SBOM',
      targetKind: 'ENDPOINT',
    }),
  );
});

test('SBOM 模式必须携带内嵌标准清单且其他模式不得夹带清单', () => {
  const sbom = {
    contentType: 'application/vnd.cyclonedx+json',
    content: JSON.stringify({
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      components: [],
    }),
  };
  const valid = serviceAssuranceCreateBodySchema.parse({
    taskId: validCreateBody.taskId,
    mode: 'SBOM',
    targetKind: 'SBOM',
    targetName: '客户组件清单',
    scopePolicyRef: 'customer-lab',
    authorizationConfirmed: false,
    sbom,
  });
  assert.equal(valid.sbom?.contentType, 'application/vnd.cyclonedx+json');

  assert.throws(() =>
    serviceAssuranceCreateBodySchema.parse({
      taskId: validCreateBody.taskId,
      mode: 'SBOM',
      targetKind: 'SBOM',
      targetName: '缺少清单',
      scopePolicyRef: 'customer-lab',
      authorizationConfirmed: false,
    }),
  );
  assert.throws(() =>
    serviceAssuranceCreateBodySchema.parse({
      ...validCreateBody,
      sbom,
    }),
  );
  assert.throws(() =>
    serviceAssuranceCreateBodySchema.parse({
      ...valid,
      sbom: { ...sbom, path: '../../etc/passwd' },
    }),
  );
});

test('sidecar 请求只使用锁定目标、固定预算和固定规则集', () => {
  const request = buildNucleiScanRequest({
    mode: 'SAFE',
    targetKind: 'ENDPOINT',
    authorizationConfirmed: false,
    target: {
      url: new URL('https://api.example.test/v1'),
      hostname: 'api.example.test',
      addresses: ['93.184.216.34'],
      pinnedAddress: '93.184.216.34',
    },
    ruleset: {
      version: 'lse-nuclei-safe-2026.08.30',
      digest: `sha256:${'a'.repeat(64)}`,
    },
  });

  assert.deepEqual(request.budget, SERVICE_ASSURANCE_REQUEST_BUDGET);
  assert.deepEqual(request.target.allowedAddresses, ['93.184.216.34']);
  assert.equal(request.target.pinnedAddress, '93.184.216.34');
  assert.equal(request.authorization.activeVerification, false);
  assert.doesNotMatch(JSON.stringify(request), /templatePath|command|apiKey|SENTINEL/i);
});

test('Nuclei 深度核验请求携带稳定授权摘要', () => {
  const input = {
    mode: 'DEEP' as const,
    targetKind: 'ENDPOINT' as const,
    authorizationConfirmed: true,
    target: {
      url: new URL('https://api.example.test/v1'),
      hostname: 'api.example.test',
      addresses: ['93.184.216.34'],
      pinnedAddress: '93.184.216.34',
    },
    ruleset: {
      version: 'lse-nuclei-deep-2026.08.30',
      digest: `sha256:${'b'.repeat(64)}`,
    },
  };

  const first = buildNucleiScanRequest(input);
  const second = buildNucleiScanRequest(input);

  assert.equal(first.authorization.activeVerification, true);
  assert.match(first.authorization.auditDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.authorization.auditDigest, second.authorization.auditDigest);
});

test('Nuclei 深度核验拒绝未确认授权的请求', () => {
  assert.throws(
    () =>
      buildNucleiScanRequest({
        mode: 'DEEP',
        targetKind: 'ENDPOINT',
        authorizationConfirmed: false,
        target: {
          url: new URL('https://api.example.test/v1'),
          hostname: 'api.example.test',
          addresses: ['93.184.216.34'],
          pinnedAddress: '93.184.216.34',
        },
        ruleset: {
          version: 'lse-nuclei-deep-2026.08.30',
          digest: `sha256:${'b'.repeat(64)}`,
        },
      }),
    /授权/,
  );
});

test('sidecar 响应拒绝原始 stderr 和未知字段', () => {
  const validResponse = {
    schemaVersion: 1,
    completed: true,
    outputJsonl: '',
    durationMs: 12,
    rulesetVersion: 'lse-nuclei-safe-2026.08.30',
    rulesetDigest: `sha256:${'a'.repeat(64)}`,
    rulesetUpdatedAt: '2026-08-30T00:00:00.000Z',
    rulesetStatus: 'CURRENT',
    engineVersion: '3.9.0',
    engineDigest: `sha256:${'b'.repeat(64)}`,
    errorCode: null,
    errorMessage: null,
  };

  assert.equal(parseNucleiScanResponse(validResponse).completed, true);
  assert.throws(() => parseNucleiScanResponse({ ...validResponse, stderr: 'internal path' }));
});

test('就绪状态只返回三种模式的客户字段并单列过期基线', () => {
  const readiness = buildServiceAssuranceReadiness({
    now: new Date('2026-08-30T12:00:00.000Z'),
    safe: {
      enabled: true,
      healthy: true,
      baselineUpdatedAt: '2026-07-01T00:00:00.000Z',
      maxBaselineAgeDays: 30,
    },
    deep: { enabled: false, healthy: false, baselineUpdatedAt: null },
    sbom: { enabled: false, healthy: false, baselineUpdatedAt: null },
  });

  assert.deepEqual(
    readiness.modes.map((item) => item.mode),
    ['SAFE', 'DEEP', 'SBOM'],
  );
  assert.equal(readiness.modes[0]?.ready, true);
  assert.match(readiness.modes[0]?.message ?? '', /过期|覆盖不完整/);
  // 过期提示要带最近一次基线日期，并给出出路（离线更新包 / 联系供应商）
  assert.match(readiness.modes[0]?.message ?? '', /2026-07-01/);
  assert.match(readiness.modes[0]?.message ?? '', /离线更新包/);
  assert.match(readiness.modes[0]?.message ?? '', /联系供应商/);
  assert.equal(readiness.modes[1]?.ready, false);
  assert.doesNotMatch(JSON.stringify(readiness), /container|image|internal|url|digest|path/i);
});
