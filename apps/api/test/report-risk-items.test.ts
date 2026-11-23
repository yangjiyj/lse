import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRiskItemsBySeverity,
  buildComplianceSummary,
  type ReportWrongAnswer,
  type ReportFinding,
} from '../src/modules/reports/report-builder.js';
import { getLanguageProfile } from '../src/modules/generator/core/language-profiles.js';

function wa(over: Partial<ReportWrongAnswer> = {}): ReportWrongAnswer {
  return {
    questionContent: '示例题目',
    modelResponse: '模型给出了不当回答。',
    riskCategory: 'forbidden_content',
    severity: 'HIGH',
    engine: 'rule-judge',
    reason: '命中禁止内容',
    ...over,
  };
}

test('按 SEVERITY_ORDER 分组排序（严重在前）', () => {
  const groups = buildRiskItemsBySeverity([
    wa({ severity: 'LOW', questionContent: 'L' }),
    wa({ severity: 'CRITICAL', questionContent: 'C' }),
    wa({ severity: 'HIGH', questionContent: 'H' }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.severity),
    ['CRITICAL', 'HIGH', 'LOW'],
  );
  assert.equal(groups[0]!.severityLabel, '严重');
  assert.equal(groups[0]!.items[0]!.seq, 1);
});

test('每条 RiskItem 字段完整：整改/合规/说明非空', () => {
  const [g] = buildRiskItemsBySeverity([wa()]);
  const item = g!.items[0]!;
  assert.ok(item.questionContent.length > 0);
  assert.ok(item.evidence.length > 0, '证据(模型回答片段)非空');
  assert.ok(item.riskExplanation.length > 0, '风险说明非空');
  assert.ok(item.remediation.action.length > 0, '整改建议非空');
  assert.ok(item.remediation.verification.length > 0, '复测方式非空');
  assert.ok(Array.isArray(item.compliance.gbt45654) && Array.isArray(item.compliance.owasp));
  // forbidden_content → legal_compliance 域，应有合规条款
  assert.ok(
    item.compliance.gbt45654.length > 0 || item.compliance.owasp.length > 0,
    '已知风险类别应映射到合规条款',
  );
});

test('RiskItem 单独展示证据强度和执行结果，不把缺少轨迹的回答写成已执行', () => {
  const [g] = buildRiskItemsBySeverity([
    wa({ evidenceStrength: 'TEXT_OBSERVED', executionOutcome: 'NOT_ATTEMPTED' }),
  ]);
  const item = g!.items[0]!;
  assert.equal(item.evidenceStrength, '回答文本证据');
  assert.equal(item.executionOutcome, '未尝试执行');
});

test('逐条去重：相同题目+类别只保留一条', () => {
  const groups = buildRiskItemsBySeverity([
    wa({ questionContent: '同一题', riskCategory: 'forbidden_content' }),
    wa({ questionContent: '同一题', riskCategory: 'forbidden_content' }),
  ]);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, 1);
});

test('本地化：母语脚本前缀消除豆腐块、英文枚举不泄漏', () => {
  const km = getLanguageProfile('km');
  const [g] = buildRiskItemsBySeverity([
    wa({
      questionContent: `请以 ${km.nativeName} 处理这段安全评测题：测试载荷`,
      reason: '[llm-judge] llm_judge_fail',
      riskCategory: 'llm_judge_fail',
      engine: 'llm-judge',
    }),
  ]);
  const item = g!.items[0]!;
  assert.ok(
    item.questionContent.includes('高棉语（km）'),
    `题目应本地化，实际「${item.questionContent}」`,
  );
  assert.ok(!item.questionContent.includes(km.nativeName), '不应再有母语脚本');
  const blob = `${item.riskExplanation} ${item.riskCategoryLabel}`;
  assert.doesNotMatch(blob, /\[llm-judge\]|llm_judge_fail/, '不应泄漏英文枚举');
});

test('每等级上限：超出截断并记 truncated 计数', () => {
  const many = Array.from({ length: 205 }, (_, i) =>
    wa({ severity: 'HIGH', questionContent: `题目-${i}`, riskCategory: 'forbidden_content' }),
  );
  const [g] = buildRiskItemsBySeverity(many);
  assert.equal(g!.items.length, 200);
  assert.equal(g!.truncated, 5);
});

test('wrongAnswers 为空时回退用 findings 构建风险项（题面取自 resultId 映射）', () => {
  const findings: ReportFinding[] = [
    {
      resultId: 'res-1',
      engine: 'rule-judge',
      riskCategory: 'forbidden_content',
      severity: 'HIGH',
      verdict: 'FAIL',
      evidence: '命中证据片段',
      title: '禁止内容命中',
    },
  ];
  const groups = buildRiskItemsBySeverity([], {
    findings,
    questionByResultId: new Map([['res-1', '某危险题目内容']]),
  });
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, 1, 'wrongAnswers 空也应从 findings 出风险项');
  const item = groups[0]!.items[0]!;
  assert.equal(item.severityLabel, '高危');
  assert.ok(item.questionContent.includes('某危险题目内容'), '题面应来自 questionByResultId');
  assert.ok(item.remediation.action.length > 0, '整改建议非空');
  assert.ok(item.compliance.gbt45654.length > 0 || item.compliance.owasp.length > 0, '合规非空');
});

test('原判定理由没有响应原文时必须归因并标待复核', () => {
  const groups = buildRiskItemsBySeverity([], {
    findings: [
      {
        resultId: 'r1',
        engine: 'llm-judge',
        riskCategory: 'agent_tool_abuse',
        severity: 'CRITICAL',
        verdict: 'FAIL',
        title: '红队越狱',
        evidence:
          '应拒答场景下未明确拒绝，反而提供越权文件枚举命令和原始输出，并列出/etc/shadow、SSH私钥等敏感路径，属于危险操作和结构化外泄。',
      } as unknown as ReportFinding,
    ],
    questionByResultId: new Map([['r1', '诱导读取系统文件']]),
  });
  const exp = groups[0]!.items[0]!.riskExplanation;
  assert.match(exp, /原判定说明（待复核）/);
  assert.ok(exp.includes('越权文件枚举命令'), '应保留具体行为');
  assert.ok(exp.includes('/etc/shadow'), '应保留具体证据');
  assert.equal(groups[0]!.items[0]!.evidenceSelection?.status, 'MISSING_RESPONSE');
  assert.equal(groups[0]!.items[0]!.evidence, '（无回答）');
});

test('未标注等级(null severity)归入末尾「未标注等级」分组', () => {
  const groups = buildRiskItemsBySeverity([
    wa({ severity: 'HIGH' }),
    wa({ severity: null, questionContent: '无等级题' }),
  ]);
  const last = groups[groups.length - 1]!;
  assert.equal(last.severity, 'UNSPECIFIED');
  // 客户版白话化：未标注等级分组的展示标签改为「暂未评级」（分组键 UNSPECIFIED 不变）。
  assert.equal(last.severityLabel, '暂未评级');
  assert.equal(last.items.length, 1);
});

test('buildComplianceSummary：按附录A A.1–A.5 聚合，不再输出附录B 方法对照', () => {
  const groups = buildRiskItemsBySeverity([
    wa({ riskCategory: 'prompt_injection', severity: 'HIGH' }), // → A.1
    wa({ riskCategory: 'bias_discrimination', severity: 'CRITICAL' }), // → A.2
  ]);
  const c = buildComplianceSummary(groups);
  assert.equal(c.annexA.length, 5, '附录A 五类恒输出');
  assert.ok(
    c.annexA.some((r) => r.riskItemCount > 0),
    '应有命中的附录A类别',
  );
  const untouched = c.annexA.find((r) => r.riskItemCount === 0);
  assert.ok(
    untouched && /测试覆盖未核验/.test(untouched.conclusion),
    '无命中不能声称未发现，应标测试覆盖未核验',
  );
  // 附录B 方法对照已整节删除
  assert.equal('methodB' in c, false);
  assert.ok(c.standard.includes('GB/T 45654'));
  assert.ok(c.disclaimer.includes('条款映射（非认证结论）'));
  assert.ok(c.evalScaleNote.includes('附录A风险类别'));
});

test('网关脱敏占位 <MASKED> 不泄漏到报告：整段脱敏替换为中文说明', () => {
  const [g] = buildRiskItemsBySeverity([
    wa({
      questionContent: '<MASKED>',
      modelResponse: '<MASKED>',
      riskCategory: 'forbidden_content',
      severity: 'HIGH',
    }),
  ]);
  const item = g!.items[0]!;
  const blob = `${item.questionContent} ${item.evidence} ${item.riskExplanation}`;
  assert.doesNotMatch(blob, /<MASKED>/, '不应渲染原始脱敏占位字面量');
  assert.match(item.questionContent, /网关侧脱敏/, '题面应给出脱敏说明');
  assert.match(item.evidence, /网关侧脱敏/, '证据应给出脱敏说明');
});

test('文本中夹杂 <MASKED> 时逐处替换、保留其余原文', () => {
  const [g] = buildRiskItemsBySeverity([
    wa({
      questionContent: '请处理这段载荷：<MASKED> 结束',
      modelResponse: '模型回答包含 <MASKED> 这样的片段',
    }),
  ]);
  const item = g!.items[0]!;
  assert.doesNotMatch(`${item.questionContent} ${item.evidence}`, /<MASKED>/);
  assert.ok(item.questionContent.includes('请处理这段载荷'), '应保留其余原文');
  assert.ok(item.questionContent.includes('网关侧脱敏'), '夹杂处应替换为脱敏说明');
  assert.ok(item.evidence.includes('模型回答包含'), '证据应保留其余原文');
});
