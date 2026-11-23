import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PATTERNS } from '../src/modules/generator/templates/index.js';
import { slotNames } from '../src/modules/generator/core/fill.js';
import { LANGUAGE, QUESTION_TYPE, RISK_DOMAIN } from '@lse/shared';

test('每条模板 id 唯一', () => {
  const ids = ALL_PATTERNS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('模板槽位闭合：template/expectedBehavior/referenceAnswer 用到的槽都有非空词表', () => {
  for (const p of ALL_PATTERNS) {
    const used = new Set<string>([
      ...slotNames(p.template),
      ...slotNames(p.expectedBehavior ?? ''),
      ...slotNames(p.referenceAnswer ?? ''),
    ]);
    for (const name of used) {
      const words = p.slots[name];
      assert.ok(Array.isArray(words) && words.length > 0, `${p.id} 缺槽位词表: ${name}`);
    }
  }
});

test('语言与题型取值合法', () => {
  for (const p of ALL_PATTERNS) {
    assert.ok((LANGUAGE as readonly string[]).includes(p.language), `${p.id} 非法语言`);
    assert.ok((QUESTION_TYPE as readonly string[]).includes(p.type), `${p.id} 非法题型`);
  }
});

test('四类题型在基础模板语言 zh 与 en 中均有覆盖', () => {
  for (const lang of ['zh', 'en'] as const) {
    for (const t of QUESTION_TYPE) {
      const hit = ALL_PATTERNS.some((p) => p.language === lang && p.type === t);
      assert.ok(hit, `基础模板语言 ${lang} 缺题型 ${t} 的模板`);
    }
  }
});

test('语言枚举覆盖中英以外的小语种', () => {
  assert.ok(LANGUAGE.length >= 40);
  assert.ok((LANGUAGE as readonly string[]).includes('ja'));
  assert.ok((LANGUAGE as readonly string[]).includes('ko'));
  assert.ok((LANGUAGE as readonly string[]).includes('ar'));
  assert.ok((LANGUAGE as readonly string[]).includes('sw'));
  assert.ok((LANGUAGE as readonly string[]).includes('yo'));
  assert.equal(new Set(LANGUAGE).size, LANGUAGE.length);
});

test('风险域枚举覆盖主流大模型与 Agent 攻击分类', () => {
  assert.deepEqual(RISK_DOMAIN, [
    'prompt_injection',
    'component_vulnerability',
    'legal_compliance',
    'privacy_leakage',
    'harmful_capability',
    'cyber_abuse',
    'fraud_social_engineering',
    'misinformation_hallucination',
    'unsafe_professional_advice',
    'bias_discrimination',
    'system_prompt_leakage',
    'training_data_extraction',
    'rag_data_poisoning',
    'agent_tool_abuse',
    'data_exfiltration',
    'ssrf_network_access',
    'output_injection',
    'model_denial_of_service',
    'model_theft',
    'general_safety',
  ]);
});

test('基础模板覆盖更完整的大模型攻击风险域', () => {
  const categories = new Set(ALL_PATTERNS.map((p) => p.category));
  for (const expected of [
    '网络滥用',
    '诈骗社工',
    '系统提示泄露',
    'RAG 污染',
    '输出处理注入',
    '模型幻觉',
    '高风险专业建议',
    '偏见歧视',
    '模型盗用',
    '资源消耗',
  ]) {
    assert.ok(categories.has(expected), `基础模板缺少分类：${expected}`);
  }
});
