import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ScannerClientError,
  requestScannerJson,
} from '../src/modules/service-assurance/adapters/client.js';
import {
  buildNucleiScanRequest,
  executeNucleiScan,
} from '../src/modules/service-assurance/adapters/nuclei.js';

const ruleset = {
  version: 'lse-nuclei-safe-2026.08.30',
  digest: `sha256:${'a'.repeat(64)}`,
};
const engineDigest = `sha256:${'b'.repeat(64)}`;

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
  ruleset,
});

const validResponse = {
  schemaVersion: 1,
  completed: true,
  outputJsonl: '',
  durationMs: 12,
  rulesetVersion: ruleset.version,
  rulesetDigest: ruleset.digest,
  rulesetUpdatedAt: '2026-08-30T00:00:00.000Z',
  rulesetStatus: 'CURRENT',
  engineVersion: '3.9.0',
  engineDigest,
  errorCode: null,
  errorMessage: null,
};

test('Nuclei adapter 只向固定 sidecar 端点发送结构化请求', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await executeNucleiScan(request, {
    baseUrl: 'http://service-assurance-scanner:8095',
    expectedEngineDigest: engineDigest,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(validResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(result.completed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'http://service-assurance-scanner:8095/v1/nuclei/scan');
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(calls[0]?.init.redirect, 'manual');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), request);
});

test('sidecar 客户端拒绝重定向、超大响应和非 JSON 响应', async () => {
  const cases: Array<{ response: Response; code: string }> = [
    {
      response: new Response(null, { status: 302, headers: { location: 'http://metadata/' } }),
      code: 'SERVICE_ASSURANCE_SIDECAR_REDIRECT',
    },
    {
      response: new Response('x'.repeat(101), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '101' },
      }),
      code: 'SERVICE_ASSURANCE_SIDECAR_RESPONSE_TOO_LARGE',
    },
    {
      response: new Response('<html>internal error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      code: 'SERVICE_ASSURANCE_SIDECAR_RESPONSE_INVALID',
    },
  ];

  for (const item of cases) {
    await assert.rejects(
      () =>
        requestScannerJson({
          baseUrl: 'http://service-assurance-scanner:8095',
          path: '/v1/test',
          method: 'GET',
          timeoutMs: 100,
          maxResponseBytes: 100,
          fetchImpl: async () => item.response,
        }),
      (error: unknown) =>
        error instanceof ScannerClientError &&
        error.code === item.code &&
        !error.message.includes('metadata') &&
        !error.message.includes('internal error'),
    );
  }
});

test('Nuclei adapter 拒绝规则集或引擎 digest 漂移', async () => {
  for (const changed of [
    { ...validResponse, rulesetDigest: `sha256:${'c'.repeat(64)}` },
    { ...validResponse, engineDigest: `sha256:${'d'.repeat(64)}` },
  ]) {
    await assert.rejects(
      () =>
        executeNucleiScan(request, {
          baseUrl: 'http://service-assurance-scanner:8095',
          expectedEngineDigest: engineDigest,
          fetchImpl: async () =>
            new Response(JSON.stringify(changed), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        }),
      (error: unknown) =>
        error instanceof ScannerClientError &&
        error.code === 'SERVICE_ASSURANCE_SIDECAR_BASELINE_MISMATCH',
    );
  }
});

test('sidecar 超时通过 AbortSignal 中止且返回稳定错误', async () => {
  await assert.rejects(
    () =>
      requestScannerJson({
        baseUrl: 'http://service-assurance-scanner:8095',
        path: '/v1/test',
        method: 'GET',
        timeoutMs: 5,
        maxResponseBytes: 100,
        fetchImpl: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      }),
    (error: unknown) =>
      error instanceof ScannerClientError && error.code === 'SERVICE_ASSURANCE_SIDECAR_TIMEOUT',
  );
});

test('Nuclei 执行遥测允许缺失但拒绝伪造数值类型、未知状态和超出预算', async () => {
  const { parseNucleiScanResponse } =
    await import('../src/modules/service-assurance/adapters/nuclei.js');
  const base = {
    schemaVersion: 1,
    completed: true,
    outputJsonl: '',
    durationMs: 1,
    rulesetVersion: 'test',
    rulesetDigest: `sha256:${'a'.repeat(64)}`,
    rulesetUpdatedAt: '2026-09-05T00:00:00.000Z',
    rulesetStatus: 'CURRENT',
    engineVersion: 'test',
    engineDigest: `sha256:${'b'.repeat(64)}`,
    errorCode: null,
    errorMessage: null,
  };
  assert.equal(parseNucleiScanResponse(base).execution, undefined);
  const check = {
    id: 'lse-http-security-headers',
    label: '响应头',
    status: 'COMPLETED',
    requestCount: 1,
    detail: '已观察实际请求。',
  };
  assert.equal(
    parseNucleiScanResponse({ ...base, execution: { checks: [check], requestCount: 1 } }).execution
      ?.checks[0]?.requestCount,
    1,
  );
  for (const invalid of [
    { requestCount: -1 },
    { requestCount: '1' },
    { requestCount: 201 },
    { status: 'PASS' },
  ]) {
    assert.throws(() =>
      parseNucleiScanResponse({
        ...base,
        execution: { checks: [{ ...check, ...invalid }], requestCount: 1 },
      }),
    );
  }
});
