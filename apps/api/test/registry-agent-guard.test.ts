import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePerQuestionEngines } from '../src/modules/engines/registry.js';

function ids(engines: { engine: string }[]): string[] {
  return engines.map((e) => e.engine);
}

test('Agent 类对象 + engines:[] → 默认包含 agent-tool-guard（无需显式勾选）', () => {
  for (const tt of ['AGENT_API', 'PUBLIC_AGENT', 'MCP_OPENAPI']) {
    const engines = ids(resolvePerQuestionEngines([], undefined, tt));
    assert.ok(engines.includes('agent-tool-guard'), `${tt} 默认应启用 agent-tool-guard`);
    assert.ok(engines.includes('rule-judge'), `${tt} 仍应保留内置 rule-judge`);
    assert.ok(engines.includes('sensitive-info'), `${tt} 仍应保留内置 sensitive-info`);
    assert.equal(
      engines.filter((e) => e === 'agent-tool-guard').length,
      1,
      `${tt} agent-tool-guard 不应重复`,
    );
  }
});

test('纯 MODEL / 未提供 targetType + engines:[] → 不默认启用 agent-tool-guard', () => {
  const model = ids(resolvePerQuestionEngines([], undefined, 'MODEL'));
  assert.ok(!model.includes('agent-tool-guard'), 'MODEL 不应默认启用 agent-tool-guard');
  const none = ids(resolvePerQuestionEngines([], undefined));
  assert.ok(!none.includes('agent-tool-guard'), '未提供 targetType 时不应默认启用');
});

test('显式 engines:[agent-tool-guard] → 任意 targetType 都能选中且只返回它', () => {
  for (const tt of ['MODEL', 'AGENT_API', 'PUBLIC_AGENT', 'MCP_OPENAPI', undefined]) {
    const engines = ids(resolvePerQuestionEngines(['agent-tool-guard'], undefined, tt));
    assert.deepEqual(
      engines,
      ['agent-tool-guard'],
      `${String(tt)} 显式勾选应只返回 agent-tool-guard`,
    );
  }
});

test('Agent 类对象显式只选 rule-judge → 默认守卫被丢弃（显式勾选覆盖默认开）', () => {
  // 默认开仅在 engines:[] 生效；一旦显式勾选其它引擎，agent-tool-guard 不应再被强行带入。
  assert.deepEqual(
    ids(resolvePerQuestionEngines(['rule-judge'], undefined, 'AGENT_API')),
    ['rule-judge'],
    'AGENT_API 显式只选 rule-judge 时不应混入默认 agent-tool-guard',
  );
});
