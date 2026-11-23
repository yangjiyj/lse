import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISK_DOMAIN } from '@lse/shared';
import {
  COMPLIANCE_MAP,
  complianceClausesForDomain,
  owaspLabel,
  gbtAnnexLabel,
  riskDomainsForGbtAnnex,
  GBT45654_ANNEX_A_LABELS,
} from '../src/modules/reports/compliance-mapping.js';

test('COMPLIANCE_MAP 为各风险域保留候选映射结构，允许证据不足时为空', () => {
  for (const domain of RISK_DOMAIN) {
    const entry = COMPLIANCE_MAP[domain];
    assert.ok(entry, `缺少风险域映射：${domain}`);
    assert.ok(Array.isArray(entry.owasp));
    for (const ax of entry.gbt45654) {
      assert.ok(ax in GBT45654_ANNEX_A_LABELS, `风险域 ${domain} 含非法附录A条款 ${ax}`);
    }
  }
});

test('附录A候选映射：内容风险可待核验对照，注入机制不能直接推定内容类别', () => {
  assert.deepEqual(complianceClausesForDomain('prompt_injection').gbt45654, []);
  assert.deepEqual(complianceClausesForDomain('bias_discrimination').gbt45654, ['A.2']);
  assert.ok(complianceClausesForDomain('privacy_leakage').gbt45654.includes('A.4'));
  // 基础设施/可用性类不属于附录A（训练数据及生成内容风险）
  assert.deepEqual(complianceClausesForDomain('component_vulnerability').gbt45654, []);
  assert.deepEqual(complianceClausesForDomain('model_denial_of_service').gbt45654, []);
});

test('提示词注入映射到 OWASP LLM01', () => {
  assert.ok(complianceClausesForDomain('prompt_injection').owasp.includes('LLM01'));
});

test('riskDomainsForGbtAnnex 反查：A.2 含歧视风险域', () => {
  const a2 = riskDomainsForGbtAnnex('A.2');
  assert.ok(a2.includes('bias_discrimination'));
  assert.ok(!a2.includes('prompt_injection'));
});

test('未知风险域返回空条款而非抛错', () => {
  assert.deepEqual(complianceClausesForDomain('not_a_real_domain'), {
    gbt45654: [],
    owasp: [],
    atlas: [],
    agentic: [],
  });
});

test('统一多标准表：ATLAS 候选阶段使用中文，缺乏阶段证据时允许为空', () => {
  for (const domain of RISK_DOMAIN) {
    const entry = COMPLIANCE_MAP[domain];
    assert.ok(Array.isArray(entry.atlas), `风险域 ${domain} 缺 ATLAS 战术`);
    // 全中文，不露英文枚举/编号
    for (const a of entry.atlas) assert.ok(!/[A-Za-z]/.test(a), `ATLAS 战术含英文：${a}`);
    for (const g of entry.agentic) assert.ok(!/[A-Za-z]/.test(g), `Agentic 威胁含英文：${g}`);
  }
});

test('智能体类风险域映射到 OWASP Agentic 威胁(工具滥用/越权/意图篡改)', () => {
  assert.ok(complianceClausesForDomain('agent_tool_abuse').agentic.includes('工具滥用'));
  assert.ok(complianceClausesForDomain('agent_tool_abuse').agentic.includes('权限提升/越权'));
  assert.deepEqual(complianceClausesForDomain('prompt_injection').agentic, []);
  assert.ok(complianceClausesForDomain('data_exfiltration').atlas.includes('数据外泄'));
});

test('owaspLabel / gbtAnnexLabel：已知码返回中文、未知原样', () => {
  assert.equal(owaspLabel('LLM01'), 'LLM01 提示词注入');
  assert.equal(owaspLabel('LLM99'), 'LLM99');
  assert.equal(gbtAnnexLabel('A.2'), 'A.2 歧视性内容');
  assert.equal(gbtAnnexLabel('A.9'), 'A.9');
});

