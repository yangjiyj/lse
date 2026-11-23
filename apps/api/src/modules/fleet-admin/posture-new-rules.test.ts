import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePosture } from '../endpoint-evals/posture-judge.js';
import { judgeProbeReport } from './posture.js';
import { CHECK_CATALOG, EXTENDED_POSTURE_CHECKS } from './check-catalog.js';
import { POSTURE_RULE_TO_CLAUSES, ENDPOINT_EXTENDED_RULES, endpointChecklistCoverage } from '@lse/shared';

const verdict = (input: Record<string, unknown>, rule: string, extended = false) =>
  judgePosture(input, [], { extended }).find((f) => f.ruleId === rule)?.verdict;

test('默认 19 条体检规则，开启扩展后 25 条，目录与规则一致', () => {
  const base = judgePosture({}).map((f) => f.ruleId).sort();
  assert.equal(base.length, 19);
  assert.deepEqual(base, CHECK_CATALOG.posture.map((c) => c.id).sort());
  const all = judgePosture({}, [], { extended: true }).map((f) => f.ruleId).sort();
  assert.equal(all.length, 25);
  assert.deepEqual(all.filter((id) => !base.includes(id)), [...ENDPOINT_EXTENDED_RULES].sort());
  assert.deepEqual(EXTENDED_POSTURE_CHECKS.map((c) => c.id).sort(), [...ENDPOINT_EXTENDED_RULES].sort());
});

test('每条规则都挂指引条款，扩展规则默认不出现', () => {
  for (const f of judgePosture({}, [], { extended: true })) {
    assert.ok(POSTURE_RULE_TO_CLAUSES[f.ruleId]?.length, f.ruleId);
    assert.ok(f.compliance.length > 0, f.ruleId);
  }
  assert.equal(verdict({}, 'run_as_admin'), undefined);
});

test('沙箱：完整主机访问失败，受限通过，没读到未知', () => {
  assert.equal(verdict({ sandbox: { full_access: true } }, 'sandbox_scope'), 'FAIL');
  assert.equal(verdict({ sandbox: { full_access: false } }, 'sandbox_scope'), 'PASS');
  assert.equal(verdict({}, 'sandbox_scope'), 'UNKNOWN');
});

test('模型出口：中转站与未列入受管目录失败，官方和网关通过，无法分类未知', () => {
  const d = (classification: string, approval_status = 'approved') => ({ classification, approval_status });
  assert.equal(verdict({ model_destinations: [d('relay')] }, 'model_destination'), 'FAIL');
  assert.equal(verdict({ model_destinations: [d('official', 'not_listed')] }, 'model_destination'), 'FAIL');
  assert.equal(verdict({ model_destinations: [d('official'), d('gateway')] }, 'model_destination'), 'PASS');
  assert.equal(verdict({ model_destinations: [d('unknown', 'unreviewed')] }, 'model_destination'), 'UNKNOWN');
  assert.equal(verdict({}, 'model_destination'), 'UNKNOWN');
});

test('版本：缺版本失败，全部有版本通过', () => {
  assert.equal(verdict({ agent_versions: [{ name: 'a', version: '' }] }, 'agent_version'), 'FAIL');
  assert.equal(verdict({ agent_versions: [{ name: 'a', version: 'version_unknown' }] }, 'agent_version'), 'FAIL');
  assert.equal(verdict({ agent_versions: [{ name: 'a', version: '2.1.0' }] }, 'agent_version'), 'PASS');
});

test('智能体平台三条规则按平台检查命中判定，没有平台组件且已采集则通过', () => {
  const pc = (rule_id: string, status: string) => ({ rule_id, status });
  const on = { platform_scanned: true };
  assert.equal(verdict({ ...on, platform_checks: [pc('platform.signup', 'finding')] }, 'platform_exposure'), 'FAIL');
  assert.equal(verdict({ ...on, platform_checks: [pc('platform.exposure', 'pass')] }, 'platform_exposure'), 'PASS');
  assert.equal(verdict({ ...on, platform_checks: [pc('platform.telemetry', 'finding')] }, 'platform_telemetry'), 'FAIL');
  assert.equal(verdict({ ...on, platform_checks: [pc('platform.version', 'finding')] }, 'platform_version'), 'FAIL');
  assert.equal(verdict({ ...on, platform_checks: [] }, 'platform_version'), 'PASS');
  assert.equal(verdict({}, 'platform_version'), 'UNKNOWN');
});

test('扩展规则：管理员、目录、日志、监听、来源、校验', () => {
  assert.equal(verdict({ run_as_admin: true }, 'run_as_admin', true), 'FAIL');
  assert.equal(verdict({ run_as_admin: false }, 'run_as_admin', true), 'PASS');
  assert.equal(verdict({ dir_scope_broad: true }, 'dir_scope', true), 'FAIL');
  assert.equal(verdict({ logging_ok: false }, 'logging', true), 'FAIL');
  assert.equal(verdict({ logging_ok: true }, 'logging', true), 'PASS');
  assert.equal(verdict({ listen_public: true }, 'listen_exposure', true), 'FAIL');
  assert.equal(verdict({ install_untrusted: true }, 'install_source', true), 'FAIL');
  assert.equal(verdict({ integrity_failed: false }, 'install_integrity', true), 'PASS');
  assert.equal(verdict({}, 'logging', true), 'UNKNOWN');
});

function report(evidence: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    collectors: [{ name: 'agents', status: 'complete' }],
    assets: [{ kind: 'cli_agent', name: 'claude-code', version: '2.1.0', evidence: { static_assessment: { checks: [] }, config: {}, ...evidence } }],
    ...extra,
  };
}

test('探针报告：沙箱静态检查、模型出口分类、平台检查被服务端用上', () => {
  const sandbox = judgeProbeReport(report({ static_assessment: { checks: [{ rule_id: 'config.sandbox', status: 'finding', evidence_code: 'sandbox_full_access' }] } }));
  assert.equal(sandbox.find((f) => f.ruleId === 'sandbox_scope')?.verdict, 'FAIL');
  const relay = judgeProbeReport(report({ endpoint: { classification: 'relay', approval_status: 'unreviewed', origin: 'https://relay.example' } }));
  assert.equal(relay.find((f) => f.ruleId === 'model_destination')?.verdict, 'FAIL');
  const official = judgeProbeReport(report({ endpoint: { classification: 'official', approval_status: 'approved' } }));
  assert.equal(official.find((f) => f.ruleId === 'model_destination')?.verdict, 'PASS');
  assert.equal(official.find((f) => f.ruleId === 'agent_version')?.verdict, 'PASS');
  const platform = judgeProbeReport({
    ...report({}),
    assets: [
      ...report({}).assets,
      { kind: 'platform_app', name: 'dify', evidence: { static_assessment: { checks: [{ rule_id: 'platform.exposure', status: 'finding' }] } } },
    ],
  });
  assert.equal(platform.find((f) => f.ruleId === 'platform_exposure')?.verdict, 'FAIL');
  assert.equal(platform.find((f) => f.ruleId === 'platform_telemetry')?.verdict, 'PASS');
});

test('探针没上报的字段保持未检，不当作通过；扩展规则默认不出现', () => {
  const findings = judgeProbeReport(report({}));
  assert.equal(findings.find((f) => f.ruleId === 'sandbox_scope')?.verdict, 'UNKNOWN');
  assert.equal(findings.find((f) => f.ruleId === 'model_destination')?.verdict, 'UNKNOWN');
  assert.equal(findings.find((f) => f.ruleId === 'run_as_admin'), undefined);
});

test('31 项清单按能力分类：自动可判 14、半自动 5、需填报 9、需探针补采 3', () => {
  const c = endpointChecklistCoverage();
  assert.deepEqual(
    [c.auto.length, c.semi.length, c.manual.length, c.probe_needed.length],
    [14, 5, 9, 3],
  );
});
