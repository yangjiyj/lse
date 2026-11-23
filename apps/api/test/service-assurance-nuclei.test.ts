import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getServiceAssurancePlannedChecks } from '@lse/shared';
import {
  normalizeNucleiJsonl,
  type NucleiNormalizationOptions,
} from '../src/modules/service-assurance/normalize/nuclei.js';
import { toFormalFindingDraft } from '../src/modules/service-assurance/decision.js';

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/service-assurance/${name}`, import.meta.url);

const normalOptions: NucleiNormalizationOptions = {
  mode: 'SAFE',
  authorizationConfirmed: false,
  completed: true,
  rulesetStatus: 'CURRENT',
  execution: {
    requestCount: 2,
    checks: getServiceAssurancePlannedChecks('SAFE', 'ENDPOINT').map((check) => ({
      id: check.id,
      label: check.label,
      status: 'COMPLETED',
      requestCount: 1,
      detail: '观察到实际请求与完整响应。',
    })),
  },
};

test('真实安全模板输出形成配置命中正式风险并保留证据哈希', async () => {
  const jsonl = await readFile(fixtureUrl('nuclei-safe-positive.jsonl'), 'utf8');
  const result = normalizeNucleiJsonl(jsonl, normalOptions);

  assert.equal(result.coverageStatus, 'COMPLETE');
  assert.equal(result.invalidLineCount, 0);
  assert.equal(result.assessments.length, 1);
  assert.equal(result.evidence.length, 1);

  const assessment = result.assessments[0]!;
  assert.equal(assessment.impactStatus, 'AFFECTED');
  assert.equal(assessment.evidenceLevel, 'CONFIG_MATCH');
  assert.equal(assessment.severity, 'HIGH');
  assert.equal(assessment.priority, 'P1');
  assert.ok(toFormalFindingDraft(assessment));
  assert.match(result.evidence[0]!.contentSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result.customerSummary), /nuclei|template|container|session/i);
});

test('Triton 只有产品名时仅形成待核验线索且不得关联 CVE', async () => {
  const jsonl = await readFile(fixtureUrl('nuclei-triton-lead.jsonl'), 'utf8');
  const result = normalizeNucleiJsonl(jsonl, normalOptions);

  assert.equal(result.components.length, 1);
  assert.equal(result.components[0]!.name, 'NVIDIA Triton 推理服务');
  assert.equal(result.components[0]!.version, null);
  assert.equal(result.assessments.length, 1);
  assert.equal(result.assessments[0]!.impactStatus, 'UNDER_INVESTIGATION');
  assert.equal(result.assessments[0]!.evidenceLevel, 'LEAD');
  assert.equal(result.assessments[0]!.advisoryId, null);
  assert.equal(toFormalFindingDraft(result.assessments[0]!), null);
  assert.doesNotMatch(JSON.stringify(result), /CVE-\d{4}-\d+/);
});

test('真实未命中输出不创建组件、判断或正式风险', async () => {
  const jsonl = await readFile(fixtureUrl('nuclei-safe-negative.jsonl'), 'utf8');
  const result = normalizeNucleiJsonl(jsonl, normalOptions);

  assert.equal(result.coverageStatus, 'COMPLETE');
  assert.deepEqual(result.components, []);
  assert.deepEqual(result.assessments, []);
  assert.deepEqual(result.evidence, []);
});

test('未知严重度保持 null 且不被映射为中危', async () => {
  const fixture = await readFile(fixtureUrl('nuclei-safe-positive.jsonl'), 'utf8');
  const event = JSON.parse(fixture.trim()) as { info: { severity?: unknown } };
  event.info.severity = 'unknown';

  const result = normalizeNucleiJsonl(`${JSON.stringify(event)}\n`, normalOptions);
  const assessment = result.assessments[0]!;
  assert.equal(assessment.severity, null);
  assert.equal(assessment.priority, 'UNKNOWN');
  assert.equal(toFormalFindingDraft(assessment)?.severity, null);
});

test('部分 JSON、未完成执行和过期规则库均显示覆盖不完整', async () => {
  const fixture = await readFile(fixtureUrl('nuclei-safe-positive.jsonl'), 'utf8');

  const invalid = normalizeNucleiJsonl(`${fixture.trim()}\n{invalid-json}\n`, normalOptions);
  assert.equal(invalid.coverageStatus, 'INCOMPLETE');
  assert.equal(invalid.invalidLineCount, 1);
  assert.ok(invalid.notices.some((item) => item.code === 'SERVICE_ASSURANCE_OUTPUT_PARTIAL'));

  const interrupted = normalizeNucleiJsonl(fixture, { ...normalOptions, completed: false });
  assert.equal(interrupted.coverageStatus, 'INCOMPLETE');
  assert.ok(interrupted.notices.some((item) => item.code === 'SERVICE_ASSURANCE_SCAN_INCOMPLETE'));

  const stale = normalizeNucleiJsonl(fixture, { ...normalOptions, rulesetStatus: 'STALE' });
  assert.equal(stale.coverageStatus, 'INCOMPLETE');
  assert.ok(stale.notices.some((item) => item.code === 'SERVICE_ASSURANCE_RULESET_STALE'));
});

test('未获深度授权的主动证据不能升级为正式风险', async () => {
  const fixture = await readFile(fixtureUrl('nuclei-safe-positive.jsonl'), 'utf8');
  const event = JSON.parse(fixture.trim()) as {
    info: { metadata?: Record<string, unknown> };
  };
  event.info.metadata = { ...event.info.metadata, 'lse-evidence': 'active' };

  const result = normalizeNucleiJsonl(`${JSON.stringify(event)}\n`, normalOptions);
  assert.equal(result.coverageStatus, 'INCOMPLETE');
  assert.equal(result.assessments[0]!.impactStatus, 'UNDER_INVESTIGATION');
  assert.equal(result.assessments[0]!.evidenceLevel, 'LEAD');
  assert.equal(toFormalFindingDraft(result.assessments[0]!), null);
  assert.ok(result.notices.some((item) => item.code === 'SERVICE_ASSURANCE_ACTIVE_NOT_AUTHORIZED'));
});

test('请求与响应证据先脱敏再截断且哨兵密钥不进入结果', async () => {
  const fixture = await readFile(fixtureUrl('nuclei-safe-positive.jsonl'), 'utf8');
  const event = JSON.parse(fixture.trim()) as { request?: string; response?: string };
  const sentinel = 'LSE_SENTINEL_DO_NOT_PERSIST_9f72a4';
  event.request = `GET / HTTP/1.1\nAuthorization: Bearer ${sentinel}`;
  event.response = `HTTP/1.1 200 OK\nSet-Cookie: session=${sentinel}`;

  const result = normalizeNucleiJsonl(`${JSON.stringify(event)}\n`, normalOptions);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
  assert.match(result.evidence[0]!.requestSummary ?? '', /\[REDACTED\]/);
  assert.match(result.evidence[0]!.responseSummary ?? '', /\[REDACTED\]/);
});

test('旧服务、漏项、未知请求数或零请求不能证明检查覆盖完整', () => {
  for (const execution of [
    undefined,
    { requestCount: 0, checks: [] },
    { ...normalOptions.execution!, requestCount: null },
    {
      requestCount: 0,
      checks: normalOptions.execution!.checks.map((check) => ({ ...check, requestCount: 0 })),
    },
    {
      requestCount: 2,
      checks: [normalOptions.execution!.checks[0]!, normalOptions.execution!.checks[0]!],
    },
  ]) {
    const result = normalizeNucleiJsonl('', { ...normalOptions, execution });
    assert.equal(result.coverageStatus, 'INCOMPLETE');
    assert.ok(
      result.notices.some((notice) => notice.code === 'SERVICE_ASSURANCE_EXECUTION_UNVERIFIED'),
    );
  }
  const legacy = normalizeNucleiJsonl('', { ...normalOptions, execution: undefined });
  assert.equal(legacy.execution?.requestCount, null);
  assert.ok(legacy.execution?.checks.every((check) => check.status === 'UNKNOWN'));
});

test('DEEP必须观察到基础检查和附加检查的实际执行', () => {
  const incomplete = normalizeNucleiJsonl('', {
    ...normalOptions,
    mode: 'DEEP',
    authorizationConfirmed: true,
  });
  assert.equal(incomplete.coverageStatus, 'INCOMPLETE');
  const complete = normalizeNucleiJsonl('', {
    ...normalOptions,
    mode: 'DEEP',
    authorizationConfirmed: true,
    execution: {
      requestCount: 3,
      checks: getServiceAssurancePlannedChecks('DEEP', 'ENDPOINT').map((check) => ({
        id: check.id,
        label: check.label,
        status: 'COMPLETED',
        requestCount: 1,
        detail: '实际执行完成。',
      })),
    },
  });
  assert.equal(complete.coverageStatus, 'COMPLETE');
  assert.equal(complete.execution?.checks.length, 3);
});
