import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuestionSetKind as k } from './kind.js';

test('内置库归为 seed', () => {
  for (const source of [
    'builtin:dataset:safety-prompts',
    'builtin:compliance:tc260',
    'builtin:mcp:x',
    'builtin:red-team:deep',
    'benchmark:abc',
  ]) {
    assert.equal(k({ isBuiltin: true, source }), 'seed', source);
  }
});

test('运行时自动落库的来源归为 run', () => {
  for (const source of [
    'red-team',
    'red-team-import',
    'comprehensive:t1:content_safety',
    'generator:abc',
    'agent-runtime:1',
    'endpoint-agent-v1',
    'multimodal-jailbreak',
    'custom-risk-fuzz',
    'fanout:tok',
    'assurance-agent:r1',
    'assurance-red-team:r1',
    '平台智能体真实观测',
    '验收测试',
  ]) {
    assert.equal(k({ isBuiltin: false, source }), 'run', source);
  }
});

test('空 source 的验收集按名称归为 run，普通空 source 为 own', () => {
  assert.equal(k({ isBuiltin: false, source: null, name: 'v1 上线验收集' }), 'run');
  assert.equal(k({ isBuiltin: false, source: '', name: '现网发布验证-0901' }), 'run');
  assert.equal(k({ isBuiltin: false, source: null, name: '我的样本' }), 'own');
});

test('用户主动产生的归为 own', () => {
  for (const source of [
    '上传:a.xlsx',
    'upload',
    'attack-seed',
    'customer-data-generator:sig',
    'benchmark:abc',
  ]) {
    assert.equal(k({ isBuiltin: false, source }), 'own', source);
  }
});

test('isBuiltin 优先于 source 前缀', () => {
  assert.equal(k({ isBuiltin: true, source: 'red-team' }), 'seed');
});
