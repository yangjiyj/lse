import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { toFormalFindingDraft } from '../src/modules/service-assurance/decision.js';
import {
  buildZapScanRequest,
  parseZapScanResponse,
} from '../src/modules/service-assurance/adapters/zap.js';
import { normalizeZapJson } from '../src/modules/service-assurance/normalize/zap.js';

const fixture = (name: string) =>
  readFile(new URL('./fixtures/service-assurance/' + name, import.meta.url), 'utf8');

const target = {
  url: new URL('https://api.example.test/openapi.json'),
  hostname: 'api.example.test',
  addresses: ['93.184.216.34'],
  pinnedAddress: '93.184.216.34',
};

const ruleset = {
  version: 'lse-rules-2026.08.30',
  digest: 'sha256:' + 'a'.repeat(64),
};

test('ZAP 请求只接受 OpenAPI 且安全模式不携带主动规则', () => {
  const request = buildZapScanRequest({
    mode: 'SAFE',
    targetKind: 'OPENAPI',
    authorizationConfirmed: false,
    target,
    ruleset,
  });
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.policy.format, 'openapi');
  assert.equal(request.policy.safeMode, true);
  assert.deepEqual(request.policy.activeRuleIds, []);
  assert.equal(request.authorization.activeVerification, false);
  assert.equal(request.authorization.auditDigest, null);
  assert.deepEqual(request.budget, {
    maxRequests: 200,
    maxConcurrency: 4,
    requestTimeoutMs: 10_000,
    totalTimeoutMs: 120_000,
    maxResponseBytes: 1_048_576,
    maxRedirects: 0,
  });
  for (const forbidden of [
    'command',
    'templatePath',
    'allowedHosts',
    'timeout',
    'concurrency',
    'apiKey',
    'credential',
  ]) {
    assert.equal(forbidden in request, false);
  }
  assert.throws(() =>
    buildZapScanRequest({
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      authorizationConfirmed: false,
      target,
      ruleset,
    }),
  );
});

test('ZAP 深度请求要求授权并只发送固定规则允许列表与审计摘要', () => {
  assert.throws(() =>
    buildZapScanRequest({
      mode: 'DEEP',
      targetKind: 'OPENAPI',
      authorizationConfirmed: false,
      target,
      ruleset,
    }),
  );
  const request = buildZapScanRequest({
    mode: 'DEEP',
    targetKind: 'OPENAPI',
    authorizationConfirmed: true,
    target,
    ruleset,
  });
  assert.equal(request.policy.safeMode, false);
  assert.deepEqual(request.policy.activeRuleIds, ['6', '40012', '40018']);
  assert.equal(request.authorization.activeVerification, true);
  assert.match(request.authorization.auditDigest ?? '', /^sha256:[a-f0-9]{64}$/);
});

test('ZAP sidecar 响应严格拒绝未知字段并保留固定基线', () => {
  const valid = {
    schemaVersion: 1,
    completed: true,
    outputJson: '{"@version":"2.16.1","site":[]}',
    durationMs: 25,
    rulesetVersion: ruleset.version,
    rulesetDigest: ruleset.digest,
    rulesetUpdatedAt: '2026-08-30T00:00:00.000Z',
    rulesetStatus: 'CURRENT',
    engineVersion: '2.16.1',
    engineDigest: 'sha256:' + 'b'.repeat(64),
    errorCode: null,
    errorMessage: null,
  };
  assert.equal(parseZapScanResponse(valid).completed, true);
  assert.throws(() => parseZapScanResponse({ ...valid, stderr: '/internal/path' }));
});

test('ZAP 安全模式固定输出形成配置命中，负样本不形成风险', async () => {
  const positive = normalizeZapJson(await fixture('zap-safe.json'), {
    mode: 'SAFE',
    authorizationConfirmed: false,
    completed: true,
    rulesetStatus: 'CURRENT',
    allowedActiveRuleIds: [],
  });
  assert.equal(positive.coverageStatus, 'COMPLETE');
  assert.equal(positive.assessments.length, 1);
  assert.equal(positive.assessments[0]?.impactStatus, 'AFFECTED');
  assert.equal(positive.assessments[0]?.evidenceLevel, 'CONFIG_MATCH');
  assert.equal(positive.assessments[0]?.severity, 'LOW');
  assert.ok(toFormalFindingDraft(positive.assessments[0]!));

  const negative = normalizeZapJson(await fixture('zap-deep-negative.json'), {
    mode: 'DEEP',
    authorizationConfirmed: true,
    completed: true,
    rulesetStatus: 'CURRENT',
    allowedActiveRuleIds: ['6', '40012', '40018'],
  });
  assert.equal(negative.coverageStatus, 'COMPLETE');
  assert.equal(negative.assessments.length, 0);
  assert.equal(negative.customerSummary.confirmed, 0);
});

test('经授权深度规则生成主动验证证据，未授权时降级且覆盖不完整', async () => {
  const raw = await fixture('zap-deep-positive.json');
  const authorized = normalizeZapJson(raw, {
    mode: 'DEEP',
    authorizationConfirmed: true,
    completed: true,
    rulesetStatus: 'CURRENT',
    allowedActiveRuleIds: ['6', '40012', '40018'],
  });
  assert.equal(authorized.assessments[0]?.impactStatus, 'AFFECTED');
  assert.equal(authorized.assessments[0]?.evidenceLevel, 'ACTIVE_VERIFIED');
  assert.ok(toFormalFindingDraft(authorized.assessments[0]!));

  const unauthorized = normalizeZapJson(raw, {
    mode: 'DEEP',
    authorizationConfirmed: false,
    completed: true,
    rulesetStatus: 'CURRENT',
    allowedActiveRuleIds: ['6', '40012', '40018'],
  });
  assert.equal(unauthorized.coverageStatus, 'INCOMPLETE');
  assert.equal(unauthorized.assessments[0]?.impactStatus, 'UNDER_INVESTIGATION');
  assert.equal(unauthorized.assessments[0]?.evidenceLevel, 'LEAD');
  assert.equal(toFormalFindingDraft(unauthorized.assessments[0]!), null);
});

test('ZAP 输出拒绝未审规则并脱敏证据中的哨兵', async () => {
  const raw = JSON.parse(await fixture('zap-deep-positive.json')) as {
    site: Array<{
      alerts: Array<{
        pluginid: string;
        instances: Array<{ evidence: string; uri: string }>;
      }>;
    }>;
  };
  raw.site[0]!.alerts[0]!.pluginid = '90000';
  raw.site[0]!.alerts[0]!.instances[0]!.evidence =
    'Authorization: Bearer LSE_ZAP_SENTINEL_NEVER_PERSIST';
  raw.site[0]!.alerts[0]!.instances[0]!.uri =
    'https://api.example.test/search?api_key=LSE_ZAP_SENTINEL_NEVER_PERSIST';
  const normalized = normalizeZapJson(JSON.stringify(raw), {
    mode: 'DEEP',
    authorizationConfirmed: true,
    completed: false,
    rulesetStatus: 'STALE',
    allowedActiveRuleIds: ['6', '40012', '40018'],
  });
  assert.equal(normalized.coverageStatus, 'INCOMPLETE');
  assert.equal(normalized.assessments.length, 0);
  assert.doesNotMatch(JSON.stringify(normalized), /LSE_ZAP_SENTINEL_NEVER_PERSIST/);
  assert.ok(
    normalized.notices.some((notice) => notice.code === 'SERVICE_ASSURANCE_RULE_NOT_ALLOWED'),
  );
});

test('ZAP 技术证据遮蔽全部公共敏感查询参数', async () => {
  const raw = JSON.parse(await fixture('zap-deep-positive.json')) as {
    site: Array<{
      alerts: Array<{
        instances: Array<{ uri: string }>;
      }>;
    }>;
  };
  raw.site[0]!.alerts[0]!.instances[0]!.uri =
    'https://api.example.test/search' +
    '?password=LSE_PASSWORD_SENTINEL' +
    '&client_secret=LSE_CLIENT_SECRET_SENTINEL' +
    '&session=LSE_SESSION_SENTINEL' +
    '&x-api-key=LSE_HEADER_KEY_SENTINEL' +
    '&page=2';

  const normalized = normalizeZapJson(JSON.stringify(raw), {
    mode: 'DEEP',
    authorizationConfirmed: true,
    completed: true,
    rulesetStatus: 'CURRENT',
    allowedActiveRuleIds: ['6', '40012', '40018'],
  });
  const serialized = JSON.stringify(normalized);

  assert.doesNotMatch(serialized, /LSE_(?:PASSWORD|CLIENT_SECRET|SESSION|HEADER_KEY)_SENTINEL/);
  assert.match(serialized, /page=2/);
});
