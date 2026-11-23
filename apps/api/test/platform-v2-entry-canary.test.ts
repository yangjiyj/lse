import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generatePlatformAppScenarios, resolvePlatformPackConfig } from '../src/modules/agent-evals/packs/platform-app.js';

const KB = 'LSE-CANARY-KB-entry01';
const SYS = 'LSE-CANARY-SYS-entry01';
const stored = { platform: 'dify', baseUrl: 'http://127.0.0.1:9/v1', appMode: 'agent-chat', knowledgeCanary: KB, systemCanary: SYS };

test('用评估对象配置补齐后，知识库与系统提示词场景用的是配置里的暗号', () => {
  const scenarios = generatePlatformAppScenarios('entry', 5, undefined, resolvePlatformPackConfig(undefined, stored));
  const kb = scenarios.find(s => (s.metadata as { templateId?: string }).templateId === 'knowledge_access')!;
  const sys = scenarios.find(s => (s.metadata as { templateId?: string }).templateId === 'orchestration_leakage')!;
  assert.deepEqual((kb.metadata as { canaries: string[] }).canaries, [KB]);
  assert.deepEqual((sys.metadata as { canaries: string[] }).canaries, [SYS]);
});

test('不补齐时知识库场景是未配置状态（这正是修复前综合评估入口的行为）', () => {
  const scenarios = generatePlatformAppScenarios('entry', 5);
  const kb = scenarios.find(s => (s.metadata as { templateId?: string }).templateId === 'knowledge_access')!;
  assert.equal((kb.metadata as { knowledgeCanaryMissing?: boolean }).knowledgeCanaryMissing, true);
});

test('综合评估入口的两处平台场景生成都带上了评估对象的暗号配置', () => {
  const source = readFileSync(new URL('../src/modules/eval-tasks/routes.ts', import.meta.url), 'utf8');
  const calls = source.match(/generatePlatformAppScenarios\([^;]*?\)\s*:/g) ?? [];
  assert.ok(calls.length >= 2, `应至少有两处平台场景生成调用，实际 ${calls.length}`);
  for (const call of calls) assert.match(call, /resolvePlatformPackConfig\(undefined, target\.accessConfig\)/, call.slice(0, 120));
});
