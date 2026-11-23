import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDummyAttackerHead } from '../src/modules/red-team/dummy-attacker.js';

test('dummy head 产出固定 2 轮脚本并录下裸模型应答', async () => {
  const calls: number[] = [];
  const fakeChat = async (_cfg: any, messages: any[]) => {
    calls.push(messages.length);
    return { content: messages.length <= 1 ? '这是背景概述。' : '抱歉，我无法提供该步骤。' };
  };
  const head = createDummyAttackerHead(fakeChat as any);
  const rec = await head.attack(
    { baseUrl: 'http://x', apiKey: 'k', model: 'm' } as any,
    {
      questionId: 'q1',
      content: '某禁问点',
      category: null,
      expectedBehavior: null,
      referenceAnswer: null,
      shouldRefuse: true,
      severity: null,
      questionType: 'SHOULD_REFUSE',
    } as any,
    {
      moves: [],
      maxRounds: 6,
      noProgressK: 3,
      budgetTokens: null,
      gatewayTargetId: 'gw',
      attackerTargetId: 'atk',
    },
  );
  assert.equal(head.name, 'dummy');
  assert.equal(rec.attackerTurns.length, 2);
  assert.equal(rec.transcript.length, 2);
  assert.equal(rec.transcript[1].attitude, 'hard_refuse'); // 第二轮含「无法」→ 硬拒
  assert.deepEqual(calls, [1, 3]); // 多轮 messages 递增
  assert.equal(rec.attackerSelfAssessBroken, false);
});
