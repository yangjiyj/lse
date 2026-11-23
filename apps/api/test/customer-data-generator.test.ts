import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCustomerDataLeakageQuestions } from '../src/modules/generator/customer-data.js';

const fields = [
  {
    key: 'apiKey',
    label: '生产 OpenAI Key',
    kind: 'api_key' as const,
    examples: ['CUSTOMER-RAW-EXAMPLE-SHOULD-NOT-APPEAR'],
  },
  { key: 'phone', label: '客户手机号', kind: 'phone' as const },
  { key: 'contract', label: '合同金额', kind: 'contract_amount' as const },
];

test('客户数据泄漏生成器按字段批量生成确定性的测评样本且不复用原始示例值', () => {
  const spec = {
    datasetName: '某银行 CRM 脱敏蓝图',
    fields,
    count: 12,
    seed: 'customer-seed-1',
    language: 'zh' as const,
  };

  const first = generateCustomerDataLeakageQuestions(spec);
  const second = generateCustomerDataLeakageQuestions(spec);

  assert.equal(first.produced, 12);
  assert.deepEqual(
    first.questions.map((q) => q.content),
    second.questions.map((q) => q.content),
  );
  assert.ok(first.questions.some((q) => q.content.includes('生产 OpenAI Key')));
  assert.ok(first.questions.some((q) => q.content.includes('客户手机号')));
  assert.ok(first.questions.some((q) => q.shouldRefuse));
  assert.ok(first.questions.some((q) => !q.shouldRefuse));
  assert.ok(first.questions.every((q) => q.tags.includes('gen:customer-data')));
  assert.ok(first.questions.every((q) => q.tags.includes('risk:data_leakage')));
  assert.ok(
    first.questions.every((q) => !q.content.includes('CUSTOMER-RAW-EXAMPLE-SHOULD-NOT-APPEAR')),
  );
});

test('客户数据泄漏生成器覆盖凭据、个人信息和业务数据风险域', () => {
  const out = generateCustomerDataLeakageQuestions({
    datasetName: '投产知识库',
    fields,
    count: 30,
    seed: 'coverage',
    language: 'zh',
  });

  const categories = new Set(out.questions.map((q) => q.category));
  assert.ok(categories.has('客户数据泄露'));
  assert.ok(categories.has('凭据/密钥泄露'));
  assert.ok(categories.has('个人信息/隐私泄露'));
  assert.ok(categories.has('业务敏感数据泄露'));
  assert.ok(out.diversity.scenarios.length >= 5);
  assert.ok(out.diversity.fieldKinds.some((item) => item.key === 'api_key'));
});
