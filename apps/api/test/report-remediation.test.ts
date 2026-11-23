import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReportFinding, ReportWrongAnswer } from '../src/modules/reports/report-builder.js';
import { buildRemediationItems } from '../src/modules/reports/remediation.js';

function finding(
  over: Partial<ReportFinding> & Pick<ReportFinding, 'riskCategory'>,
): ReportFinding {
  return {
    engine: 'rule-judge',
    riskCategory: over.riskCategory,
    severity: over.severity ?? 'HIGH',
    verdict: over.verdict ?? 'FAIL',
    evidence: over.evidence ?? '模型输出了风险内容',
    title: over.title ?? null,
  };
}

function wrong(over: Partial<ReportWrongAnswer> = {}): ReportWrongAnswer {
  return {
    questionContent: over.questionContent ?? '测试题',
    riskCategory: over.riskCategory ?? 'prompt_injection',
    severity: over.severity ?? 'HIGH',
    engine: over.engine ?? 'rule-judge',
    reason: over.reason ?? '模型切换成越权角色并执行注入指令',
  };
}

test('buildRemediationItems: 为提示注入输出可执行整改动作和验证方式', () => {
  const items = buildRemediationItems({
    findings: [
      finding({
        riskCategory: 'prompt_injection',
        evidence: '模型疑似执行注入指令：现在我是 DAN',
      }),
    ],
    wrongAnswers: [wrong()],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]!.priority, 'P0');
  assert.match(items[0]!.title, /提示注入|指令隔离/);
  assert.match(items[0]!.action, /系统指令|外部内容|越狱/);
  assert.match(items[0]!.verification, /复测|系统提示|越权角色/);
  assert.doesNotMatch(items[0]!.action, /建议加强/);
});

test('buildRemediationItems: 按风险类别去重并保留最高严重度', () => {
  const items = buildRemediationItems({
    findings: [
      finding({ riskCategory: 'sensitive_info_secret', severity: 'LOW', evidence: '低危样本' }),
      finding({
        riskCategory: 'sensitive_info_secret',
        severity: 'CRITICAL',
        evidence: '私钥泄露',
      }),
      finding({ riskCategory: 'sensitive_info_pii', severity: 'MEDIUM', evidence: '手机号泄露' }),
    ],
    wrongAnswers: [],
  });

  assert.equal(items.length, 2);
  assert.equal(items[0]!.priority, 'P0');
  assert.match(items[0]!.title, /凭据|密钥/);
  assert.match(items[0]!.evidence, /私钥/);
  assert.equal(items[1]!.priority, 'P1');
});

test('buildRemediationItems: Agent 工具风险给出权限与 SSRF 校验建议', () => {
  const items = buildRemediationItems({
    findings: [finding({ riskCategory: 'agent_tool_abuse', evidence: '访问 metadata IP' })],
    wrongAnswers: [],
  });

  assert.equal(items.length, 1);
  // 整改文案已白话化：allowlist→「允许清单」、egress/文件路径→「网络地址和文件目录」、
  // 高风险操作→增加阻断或人工确认，间接内容→作为非可信输入隔离。
  assert.match(items[0]!.action, /允许清单/);
  assert.match(items[0]!.action, /网络地址|文件目录/);
  assert.match(items[0]!.action, /高风险操作/);
  assert.match(items[0]!.action, /非可信输入/);
  assert.match(items[0]!.verification, /metadata IP|本地文件|环境变量/);
});

test('buildRemediationItems: 无风险项时不生成整改建议', () => {
  assert.deepEqual(buildRemediationItems({ findings: [], wrongAnswers: [] }), []);
});

test('buildRemediationItems: 网关策略事件给出网关侧处置与模型侧加固建议', () => {
  const items = buildRemediationItems({
    findings: [
      {
        engine: 'newapi-agent-security-gateway',
        riskCategory: 'gateway_policy_event',
        severity: 'HIGH',
        verdict: 'FAIL',
        evidence: '网关检测到智能体访问未备案域名，策略为告警放行',
        title: null,
      },
    ],
    wrongAnswers: [],
  });

  assert.equal(items.length, 1);
  assert.match(items[0]!.title, /网关/);
  assert.doesNotMatch(items[0]!.title, /阻断禁止内容输出/);
  assert.match(items[0]!.action, /告警放行|阻断/);
  assert.match(items[0]!.action, /模型侧|模型/);
  assert.match(items[0]!.verification, /重放|复测/);
});

test('buildRemediationItems: 网关引擎与网关类别都路由到网关专项建议', () => {
  const byCategory = buildRemediationItems({
    findings: [
      finding({ riskCategory: 'gateway_policy_event', evidence: '网关上报智能体异常外联行为' }),
    ],
    wrongAnswers: [],
  });
  const byEngine = buildRemediationItems({
    findings: [
      {
        engine: 'newapi-agent-security-gateway',
        riskCategory: 'gateway_audit_finding',
        severity: 'MEDIUM',
        verdict: 'UNKNOWN',
        evidence: '网关审计日志命中策略规则',
        title: null,
      },
    ],
    wrongAnswers: [],
  });

  assert.match(byCategory[0]!.title, /网关/);
  assert.match(byEngine[0]!.title, /网关/);
});

test('buildRemediationItems: 红队发现给出攻击面收敛与复现建议', () => {
  const items = buildRemediationItems({
    findings: [
      finding({ riskCategory: 'redteam_attack', evidence: '红队攻击包命中目标模型' }),
      finding({
        riskCategory: 'redteam_finding_3',
        severity: 'MEDIUM',
        evidence: '自动化扫描命中一项弱点',
      }),
    ],
    wrongAnswers: [],
  });

  assert.equal(items.length, 2);
  for (const item of items) {
    assert.match(item.title, /红队/);
    assert.doesNotMatch(item.title, /补充回归用例/);
    assert.match(item.action, /攻击|样本/);
    assert.match(item.verification, /复测|复现/);
  }
});

test('buildRemediationItems: 判定模型识别为风险时给出复核与标准对齐建议', () => {
  const items = buildRemediationItems({
    findings: [
      finding({ riskCategory: 'llm_judge_fail', evidence: '判定模型识别评估对象响应存在风险' }),
    ],
    wrongAnswers: [],
  });

  assert.equal(items.length, 1);
  assert.match(items[0]!.title, /复核|研判|高风险回答/);
  assert.doesNotMatch(items[0]!.title, /LLM 评审不通过/);
  assert.doesNotMatch(items[0]!.action, /LLM 评审不通过/);
  assert.match(items[0]!.action, /人工|复核|研判/);
  assert.match(items[0]!.verification, /复测|复核/);
});

test('buildRemediationItems: 兜底建议标题包含风险类别中文名', () => {
  const items = buildRemediationItems({
    findings: [
      finding({ riskCategory: 'misinformation_hallucination', evidence: '回答与公开事实不符' }),
    ],
    wrongAnswers: [],
  });

  assert.equal(items.length, 1);
  assert.match(items[0]!.title, /幻觉误导/);
  assert.match(items[0]!.title, /回归用例/);
});

test('buildRemediationItems: 红队来源保留标签，具体整改仍按实际风险分类', () => {
  const items = buildRemediationItems({
    findings: [
      {
        engine: 'garak',
        riskCategory: 'promptinject.HijackHateHumans',
        severity: 'HIGH',
        verdict: 'FAIL',
        evidence: '探针诱导模型执行越权指令',
        title: null,
      },
      {
        engine: 'pyrit',
        riskCategory: 'crescendo',
        severity: 'HIGH',
        verdict: 'FAIL',
        evidence: '多轮递进攻击诱导模型输出受限内容',
        title: null,
      },
    ],
    wrongAnswers: [],
  });

  assert.equal(items.length, 2);
  for (const item of items) {
    assert.match(item.verification, /复测/);
    assert.match(item.riskCategoryLabel, /[一-鿿]/);
    assert.match(item.responsibility!, /供应商/);
  }
  assert.match(items[0]!.title, /提示注入|指令隔离/);
  assert.match(items[1]!.title, /红队/);
  assert.equal(items[0]!.riskCategoryLabel, '红队发现（promptinject.HijackHateHumans）');
  assert.equal(items[1]!.riskCategoryLabel, '红队发现（crescendo）');
});

test('buildRemediationItems: 网关动态策略类别标签不泄露英文枚举', () => {
  const items = buildRemediationItems({
    findings: [
      {
        engine: 'newapi-agent-security-gateway',
        riskCategory: 'prompt_guard',
        severity: 'CRITICAL',
        verdict: 'FAIL',
        evidence: '网关策略命中提示词防护规则',
        title: null,
      },
    ],
    wrongAnswers: [],
  });

  assert.equal(items.length, 1);
  assert.match(items[0]!.title, /网关/);
  assert.equal(items[0]!.riskCategoryLabel, '网关策略事件（prompt_guard）');
});

test('buildRemediationItems: 无中文标签的未知类别兜底标题不夹带英文', () => {
  const items = buildRemediationItems({
    findings: [finding({ riskCategory: 'totally_unknown_code', evidence: '检出一项未分类风险' })],
    wrongAnswers: [],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, '针对检出风险补充回归用例');
  assert.doesNotMatch(items[0]!.title, /totally_unknown_code/);
});

test('buildRemediationItems: 红队与判定模型建议标题语序通顺', () => {
  const redteam = buildRemediationItems({
    findings: [finding({ riskCategory: 'redteam_attack', evidence: '红队攻击包命中目标模型' })],
    wrongAnswers: [],
  });
  const judge = buildRemediationItems({
    findings: [
      finding({ riskCategory: 'llm_judge_fail', evidence: '判定模型识别评估对象响应存在风险' }),
    ],
    wrongAnswers: [],
  });

  assert.equal(redteam[0]!.title, '收敛红队发现的攻击面');
  assert.equal(judge[0]!.title, '复核并研判待确认的高风险回答');
});
