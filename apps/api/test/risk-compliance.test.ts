import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPLIANCE_LEGAL_REFERENCES,
  COMPLIANCE_RISK_CATEGORIES,
  COMPLIANCE_RISK_CATEGORY_LABELS,
  RISK_LEVEL_LABELS,
  classifyComplianceRiskCategory,
  describeFindingCompliance,
  severityToRiskLevel,
} from '@lse/shared';

test('严重度映射为高/中/低风险', () => {
  assert.equal(severityToRiskLevel('CRITICAL'), 'HIGH');
  assert.equal(severityToRiskLevel('HIGH'), 'HIGH');
  assert.equal(severityToRiskLevel('MEDIUM'), 'MEDIUM');
  assert.equal(severityToRiskLevel('LOW'), 'LOW');
  assert.equal(severityToRiskLevel('INFO'), 'LOW');
  assert.deepEqual(RISK_LEVEL_LABELS, { HIGH: '高风险', MEDIUM: '中风险', LOW: '低风险' });
});

test('招标要求的 8 类风险类别都有中文标签与法规关联', () => {
  const required = [
    '涉政',
    '涉暴',
    '涉黄',
    '恐怖主义',
    '非法行为指导',
    '偏见歧视',
    '提示注入',
    '间接提示注入',
  ];
  const labels = Object.values(COMPLIANCE_RISK_CATEGORY_LABELS);
  for (const label of required) assert.ok(labels.includes(label), label);
  for (const category of COMPLIANCE_RISK_CATEGORIES) {
    const refs = COMPLIANCE_LEGAL_REFERENCES[category];
    assert.ok(refs.length > 0, category);
    for (const ref of refs) {
      assert.match(ref.law, /《.+》/);
      assert.doesNotMatch(
        ref.topic + ref.law,
        /第[一二三四五六七八九十百零〇\d]+条/,
        '不得编造条号',
      );
    }
  }
});

test('引擎风险类别与题目类别归入合规风险类别', () => {
  assert.equal(
    classifyComplianceRiskCategory('indirect_prompt_injection'),
    'indirect_prompt_injection',
  );
  assert.equal(classifyComplianceRiskCategory('prompt_injection'), 'prompt_injection');
  assert.equal(classifyComplianceRiskCategory('极端主义与恐怖'), 'terrorism');
  assert.equal(classifyComplianceRiskCategory('政治敏感与价值观'), 'political');
  assert.equal(classifyComplianceRiskCategory('仇恨歧视'), 'bias_discrimination');
  assert.equal(classifyComplianceRiskCategory('sensitive_info_pii'), 'sensitive_info_leakage');
  assert.equal(classifyComplianceRiskCategory('危险物品'), 'illegal_guidance');
  assert.equal(classifyComplianceRiskCategory('llm_judge_fail', '涉黄内容'), 'pornography');
  assert.equal(
    classifyComplianceRiskCategory('custom_risk:pipeline_coordinates'),
    'custom_risk_content',
  );
  assert.equal(classifyComplianceRiskCategory('general', null), null);
});

test('评估结论视图输出风险等级、类别与法律法规', () => {
  const view = describeFindingCompliance({
    severity: 'CRITICAL',
    riskCategory: 'prompt_injection',
  });
  assert.equal(view.riskLevelLabel, '高风险');
  assert.equal(view.complianceCategoryLabel, '提示注入');
  assert.ok(view.legalReferences.some((ref) => ref.law === '《网络安全法》'));
  const unknown = describeFindingCompliance({ severity: 'LOW', riskCategory: 'general' });
  assert.equal(unknown.riskLevelLabel, '低风险');
  assert.equal(unknown.complianceCategory, null);
  assert.deepEqual(unknown.legalReferences, []);
});
