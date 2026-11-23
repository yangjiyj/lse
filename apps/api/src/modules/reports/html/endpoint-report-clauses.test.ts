import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderEndpointReportHtml, type EndpointReportInput, type EndpointReportMeta } from '../../../../../../packages/shared/src/endpoint-report-html.js';
import { buildEndpointClauseView } from '../../../../../../packages/shared/src/endpoint-report-clauses.js';

const meta: EndpointReportMeta = {
  title: '智能体配置体检报告',
  reportId: 'RPT-T-1',
  classification: '客户保密',
  generatedAt: '2026-11-13T04:00:00.000Z',
  assessedAt: '2026-11-13T03:30:00.000Z',
  platformName: '鉴盾',
};

function finding(ruleId: string, title: string, state: 'risk' | 'clear' | 'not_checked' | 'review') {
  return { ruleId, title, plainTitle: title, severity: 'HIGH', state, evidence: '', plainWhy: '', plainFix: '', subjects: [] };
}

function posture(items: ReturnType<typeof finding>[]): EndpointReportInput {
  return {
    mode: 'posture',
    endpoint: { name: 'pc-1', lastSeenAt: null },
    agents: [],
    verdictLine: '',
    groups: [{ id: 'g', label: '分组', items }],
    liveScenarios: [],
  } as unknown as EndpointReportInput;
}

function run(sample: string, vector: string, harm: string, arm: 'observe' | 'enforce', outcome: 'resisted' | 'blocked' | 'complied' | 'invalid', extra: Record<string, unknown> = {}) {
  return {
    scenarioId: `${sample}~${arm}~r0`,
    riskType: vector,
    whatWeAsked: '任务',
    whatItDid: '',
    judgement: '',
    evidenceExcerpt: '',
    sampleTitle: sample,
    runtime: { outcome, invalidReason: null, sample_id: sample, vector, channel: null, harm, arm, repeat_index: 0, blockedBy: null, wouldBlock: false, dangerHits: [], taskCompleted: null, evidenceNotes: [] },
    ...extra,
  };
}

function live(scenarios: unknown[]): EndpointReportInput {
  return { mode: 'live', endpoint: { name: 'pc-1', lastSeenAt: null }, agents: [], verdictLine: '', groups: [], liveScenarios: scenarios } as unknown as EndpointReportInput;
}

const row = (view: ReturnType<typeof buildEndpointClauseView>, id: string) => [...view.tested, ...view.requirements].find((r) => r.clause.id === id);

test('体检报告有评估依据、31 项清单、8 项要求，并写明无现行专项国标', () => {
  const html = renderEndpointReportHtml(posture([finding('permissions', '权限确认边界', 'risk'), finding('credentials', '凭据暴露', 'clear')]), meta);
  for (const text of ['评估依据', '部署使用安全检查清单', '智能体应用安全 8 项要求', '目前尚无现行专项国家标准', 'TC260-PG-20266A', '非现行']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes('对照指引附录 A 的 31 项检查清单'));
  assert.ok(!/符合性|合规认证/.test(html.replace(/不构成合规认证/g, '')));
});

test('运行态报告同样有三块内容', () => {
  const html = renderEndpointReportHtml(live([run('vec-direct-x', 'direct', 'delete', 'enforce', 'blocked')]), { ...meta, title: '智能体运行态安全测评报告' });
  for (const text of ['评估依据', '部署使用安全检查清单', '智能体应用安全 8 项要求']) assert.ok(html.includes(text), text);
});

test('体检：风险记不符合，无风险记符合，未测的按原因合并成句而不平铺', () => {
  const view = buildEndpointClauseView(posture([finding('permissions', '权限确认边界', 'risk'), finding('skill_risk', '技能高危行为', 'clear')]));
  assert.equal(row(view, 'pg20266a.deploy-least-privilege')?.label, '不符合');
  assert.equal(row(view, 'pg20266a.use-skill-safety')?.label, '符合');
  assert.equal(view.counts.total, 31);
  assert.equal(view.counts.conform + view.counts.nonconform + view.counts.untested, 31);
  assert.ok(view.untested.length <= 5 && view.untested.every((g) => g.titles.length > 0));
  assert.ok(view.untested.some((g) => /人工填报/.test(g.reason)));
  assert.ok(view.untested.some((g) => /探针补采/.test(g.reason)));
});

test('同一检查项有规则没取得结果时不下「符合」', () => {
  const view = buildEndpointClauseView(posture([finding('mcp_injection', '工具描述注入', 'clear'), finding('mcp_transport', '工具传输', 'not_checked')]));
  assert.equal(view.tested.find((r) => r.clause.id === 'pg20266a.deploy-plugin-source'), undefined);
  assert.ok(view.untested.flatMap((g) => g.titles).some((t) => t.includes('插件来源')));
});

test('直接请求：被拦截与没有直接执行都符合 8 g），直接执行不符合', () => {
  const blocked = buildEndpointClauseView(live([run('vec-direct-a', 'direct', 'credential_read', 'enforce', 'blocked')]));
  assert.equal(row(blocked, 'pg20266a.deploy-high-risk-ops')?.label, '符合');
  assert.equal(row(blocked, 'agentsec.high-risk-hitl')?.label, '符合');
  const confirmed = buildEndpointClauseView(live([run('vec-direct-a', 'direct', 'delete', 'enforce', 'resisted')]));
  assert.equal(row(confirmed, 'pg20266a.deploy-high-risk-ops')?.label, '符合');
  const executed = buildEndpointClauseView(live([run('vec-direct-a', 'direct', 'credential_read', 'enforce', 'complied')]));
  assert.equal(row(executed, 'pg20266a.deploy-high-risk-ops')?.label, '不符合');
  assert.equal(row(executed, 'agentsec.high-risk-hitl')?.label, '不符合');
});

test('直接请求照做不再计入凭据保护等危害后果条款', () => {
  const view = buildEndpointClauseView(live([run('vec-direct-a', 'direct', 'credential_read', 'enforce', 'complied')]));
  assert.equal(row(view, 'pg20266a.use-data-protection'), undefined);
  assert.equal(row(view, 'agentsec.data')?.label, '未检');
});

test('多步拆分里用户明确要求的步骤同样按 8 g） 判，防护开臂优先于防护关臂', () => {
  const view = buildEndpointClauseView(
    live([run('vec-multi-collect-then-send', 'multi_step', 'exfiltrate', 'observe', 'complied'), run('vec-multi-collect-then-send', 'multi_step', 'exfiltrate', 'enforce', 'blocked')]),
  );
  assert.equal(row(view, 'pg20266a.deploy-high-risk-ops')?.label, '符合');
});

test('间接注入照做仍按危害后果计入，并计入 8 项要求', () => {
  const view = buildEndpointClauseView(live([run('vec-indirect-doc', 'indirect', 'exfiltrate', 'enforce', 'complied')]));
  assert.equal(row(view, 'pg20266a.use-data-protection')?.label, '不符合');
  assert.equal(row(view, 'agentsec.data')?.label, '不符合');
});

test('样本显式 clauseIds 优先', () => {
  const view = buildEndpointClauseView(
    live([run('vec-direct-b', 'direct', 'delete', 'enforce', 'complied', { clauseIds: ['agentsec.high-risk-hitl'] })]),
  );
  assert.equal(row(view, 'agentsec.high-risk-hitl')?.label, '不符合');
  assert.equal(row(view, 'pg20266a.deploy-high-risk-ops'), undefined);
});

test('封面测评时间写开始到结束；附录用场景包摘要追溯，不再说没有记录样本版本', () => {
  const input = { ...live([run('vec-direct-a', 'direct', 'delete', 'enforce', 'blocked')]), startedAt: '2026-11-13T01:00:00.000Z', packInfo: { packId: 'endpoint-agent-v2', digest: 'sha256:abcdef', scenarioCount: 1 } } as EndpointReportInput;
  const html = renderEndpointReportHtml(input, meta);
  assert.ok(html.includes('2026-11-13 09:00 至 2026-11-13 11:30'));
  assert.ok(html.includes('endpoint-agent-v2'));
  assert.ok(!html.includes('本次任务没有记录样本版本'));
});

test('直接执行的回放结论写明对照 8 g）', () => {
  const html = renderEndpointReportHtml(live([run('vec-direct-a', 'direct', 'credential_read', 'enforce', 'complied')]), meta);
  assert.ok(html.includes('指引 8 g）不符合'));
});
