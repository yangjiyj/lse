import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveReportRiskDomain,
  riskDomainForCategory,
  reportRiskTypeLabel,
  reportRuleActionLabel,
} from '../src/modules/reports/labels.js';
import {
  remediationGuidance,
  buildRemediationItemsFromRisks,
} from '../src/modules/reports/remediation.js';
import { buildRiskPortfolio } from '../src/modules/reports/risk-portfolio.js';
import {
  complianceClausesForDomain,
  COMPLIANCE_MAPPING_STATUS,
  COMPLIANCE_MAPPING_NOTE,
} from '../src/modules/reports/compliance-mapping.js';
import type {
  ReportFinding,
  ReportWrongAnswer,
  ReportEvalResult,
} from '../src/modules/reports/report-builder.js';

test('内容评估提到组件/供应链/CVE，不能成为实际资产漏洞或工具执行的证据', () => {
  for (const context of [
    '合成演练题：讨论组件漏洞和供应链场景中的网络入侵方法；不含真实攻击步骤。',
    '合成演练题：讨论 CVE-2099-1234 漏洞利用风险；不含真实攻击步骤。',
  ]) {
    const input = { riskCategory: 'llm_judge_fail', engine: 'llm-judge', questionContent: context };
    assert.equal(resolveReportRiskDomain(input), 'cyber_abuse');
    assert.equal(riskDomainForCategory(input.riskCategory, context), 'cyber_abuse');
    assert.equal(reportRiskTypeLabel(input), '网络安全/恶意滥用');
    const guidance = remediationGuidance(input);
    assert.match(guidance.title, /网络滥用/);
    assert.match(guidance.action, /输入意图识别与输出审查/);
    assert.doesNotMatch(guidance.title, /修复组件|供应链/);
    assert.deepEqual(complianceClausesForDomain('cyber_abuse').owasp, []);
    assert.deepEqual(complianceClausesForDomain('cyber_abuse').agentic, []);
  }
});

test('明确的组件检测保留组件整改，普通文本提到漏洞不触发组件推断', () => {
  assert.equal(
    resolveReportRiskDomain({
      riskCategory: 'component_vulnerability',
      engine: 'trivy',
      evidence: '合成组件版本命中；用于网络攻击防御测试',
    }),
    'component_vulnerability',
  );
  assert.equal(
    resolveReportRiskDomain({
      riskCategory: 'scanner_finding',
      engine: 'trivy',
      evidence: 'CVE-2099-1234 合成扫描证据',
    }),
    'component_vulnerability',
  );
  assert.equal(
    resolveReportRiskDomain({
      riskCategory: 'llm_judge_fail',
      engine: 'llm-judge',
      evidence: '模型回答提到了组件、供应链、CVE-2099-1234。',
    }),
    'general_safety',
  );
  assert.match(
    remediationGuidance({
      riskCategory: 'component_vulnerability',
      engine: 'trivy',
    }).verificationScope!,
    /同一受影响资产/,
  );
});

test('一般输出、资源、token、记忆等词语不会自动推定技术攻击机制', () => {
  for (const evidence of [
    '模型输出了一个普通回答。',
    'The response lists resource and memory terms with token counts.',
  ]) {
    assert.equal(
      resolveReportRiskDomain({ riskCategory: 'llm_judge_fail', evidence }),
      'general_safety',
    );
  }
  assert.equal(resolveReportRiskDomain({ riskCategory: 'output_injection' }), 'output_injection');
});

test('显式业务风险域优先于题目中的攻击包装，整改和风险类型一致', () => {
  const input = {
    riskCategory: 'cyber_abuse',
    engine: 'pyrit',
    title: '红队越狱：供应链提示注入包装',
    evidence: '合成样例：模型给出网络滥用内容描述。',
  };
  assert.equal(resolveReportRiskDomain(input), 'cyber_abuse');
  assert.equal(reportRiskTypeLabel(input), '网络安全/恶意滥用');
  assert.match(remediationGuidance(input).title, /网络滥用/);
});

test('模拟去匿名化方法标为方法风险，不能直接称已泄露真实个人信息', () => {
  const input = {
    riskCategory: 'llm_judge_fail',
    engine: 'llm-judge',
    questionContent: '合成数据演练：讨论去匿名化方法的风险。',
    evidence: '响应描述了模拟身份关联流程；未提供真实个人信息。',
  };
  assert.equal(resolveReportRiskDomain(input), 'privacy_leakage');
  assert.equal(reportRiskTypeLabel(input), '隐私推断/去匿名化风险');
  assert.match(reportRuleActionLabel(input), /方法输出风险/);
  assert.doesNotMatch(reportRuleActionLabel(input), /已泄露|输出敏感信息/);
  const guidance = remediationGuidance(input);
  assert.match(guidance.title, /方法输出/);
  assert.match(guidance.action, /不能直接认定已取得真实个人信息/);
  assert.match(guidance.verification, /模拟匹配当成实际泄露/);
});

test('提示词披露按实际影响核验，应用与供应商整改职责及复测边界可追溯', () => {
  const guidance = remediationGuidance({
    riskCategory: 'system_prompt_leakage',
    engine: 'llm-judge',
  });
  assert.match(guidance.action, /普通指令不自动等同凭据泄露/);
  assert.match(guidance.action, /模型外的代码/);
  assert.match(guidance.responsibility!, /第三方 API.*供应商/);
  assert.match(guidance.responsibility!, /自部署模型.*模型维护方/);
  assert.match(guidance.responsibility!, /评估平台.*复测/);
  assert.match(guidance.verificationScope!, /裸模型.*完整应用/);
  assert.match(guidance.verificationScope!, /不等于基础模型已修复/);
  assert.match(guidance.verificationScope!, /执行异常和待判定结果不计为通过/);
});

test('同一评审类别的网络滥用与隐私方法风险分别生成整改，不借另一题的风险主题', () => {
  const findings: ReportFinding[] = ['cyber', 'privacy'].map((resultId) => ({
    resultId,
    engine: 'llm-judge',
    riskCategory: 'llm_judge_fail',
    severity: 'HIGH',
    verdict: 'FAIL',
    evidence: '待复核的合成响应',
    title: null,
  }));
  const wrongAnswers: ReportWrongAnswer[] = [
    {
      resultId: 'cyber',
      riskCategory: 'llm_judge_fail',
      engine: 'llm-judge',
      severity: 'HIGH',
      questionContent: '合成样例：组件供应链相关网络入侵方法风险',
      reason: null,
    },
    {
      resultId: 'privacy',
      riskCategory: 'llm_judge_fail',
      engine: 'llm-judge',
      severity: 'HIGH',
      questionContent: '合成样例：隐私去匿名化方法风险',
      reason: null,
    },
  ];
  const portfolio = buildRiskPortfolio({
    findings,
    wrongAnswers,
    results: [] as ReportEvalResult[],
  });
  const items = buildRemediationItemsFromRisks(portfolio.activeRisks);
  assert.equal(items.length, 2);
  assert.ok(items.some((item) => /网络滥用/.test(item.title)));
  assert.ok(items.some((item) => /去匿名化方法/.test(item.title)));
  assert.ok(items.every((item) => !/修复组件/.test(item.title)));
});

test('不从有害内容推定注入/代理，不从提示词推定商业秘密，映射和题库能力均待核验', () => {
  assert.equal(COMPLIANCE_MAPPING_STATUS, 'PENDING_REVIEW');
  assert.match(COMPLIANCE_MAPPING_NOTE, /不代表测试覆盖/);
  assert.deepEqual(complianceClausesForDomain('harmful_capability').owasp, []);
  assert.deepEqual(complianceClausesForDomain('system_prompt_leakage').gbt45654, []);
  assert.deepEqual(complianceClausesForDomain('general_safety'), {
    gbt45654: [],
    owasp: [],
    atlas: [],
    agentic: [],
  });
});
