import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReActAttackerHead,
  extractTokenUsage,
} from '../src/modules/red-team/react-attacker.js';

const seed = {
  questionId: 'q1',
  content: '某禁问点',
  category: '危险化学',
  expectedBehavior: null,
  referenceAnswer: null,
  shouldRefuse: true,
  severity: 'HIGH',
  questionType: 'SHOULD_REFUSE',
} as any;
const cfg = {
  moves: ['academic_wrap', 'foot_in_door'],
  maxRounds: 6,
  noProgressK: 3,
  budgetTokens: null,
  gatewayTargetId: 'gw',
  attackerTargetId: 'atk',
};

// ============ extractTokenUsage 纯函数：安全把 usage:unknown 转 number，永不抛 ============

test('extractTokenUsage 优先取有限的 total_tokens', () => {
  assert.equal(
    extractTokenUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 33 }),
    33,
  );
});

test('extractTokenUsage 无 total_tokens 时回落 prompt+completion', () => {
  assert.equal(extractTokenUsage({ prompt_tokens: 10, completion_tokens: 20 }), 30);
});

test('extractTokenUsage total_tokens 非有限值时回落 prompt+completion', () => {
  assert.equal(
    extractTokenUsage({ prompt_tokens: 7, completion_tokens: 8, total_tokens: NaN }),
    15,
  );
  assert.equal(
    extractTokenUsage({ prompt_tokens: 7, completion_tokens: 8, total_tokens: Infinity }),
    15,
  );
});

test('extractTokenUsage 对 null/undefined/畸形/非数字一律返回 0，绝不抛', () => {
  assert.equal(extractTokenUsage(null), 0);
  assert.equal(extractTokenUsage(undefined), 0);
  assert.equal(extractTokenUsage(42), 0);
  assert.equal(extractTokenUsage('lots'), 0);
  assert.equal(extractTokenUsage({}), 0);
  assert.equal(extractTokenUsage({ total_tokens: 'x' }), 0);
  assert.equal(extractTokenUsage({ prompt_tokens: 10 }), 0); // 只有一半，无 total → 0
  assert.equal(extractTokenUsage({ prompt_tokens: 'a', completion_tokens: 5 }), 0);
});

// ============ 预算闸集成：累计 token 达阈值 → stopReason='budget' 提前终止 ============

test('每轮累计 think+obs 的 token，达 budgetTokens → budget 终止', async () => {
  // 目标永远软拒（既不松口=success，也不触发 no_progress），唯一停因应是 budget。
  // 每轮 think.usage=100 + obs.usage=100 = 200 token；budgetTokens=300 → 第 2 轮后累计 400>=300 停。
  const chat = async (target: any) => {
    if (target.model === 'atk') {
      return {
        content: JSON.stringify({ move: 'academic_wrap', message: 'x', rationale: 'r' }),
        usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
      };
    }
    return {
      content: '我理解你的研究，但是这部分需要谨慎，从合规角度建议咨询专业人士。', // 软拒
      usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
    };
  };
  const head = createReActAttackerHead(chat as any, {
    loadAttackerTarget: async () => ({ baseUrl: 'http://atk', apiKey: 'k', model: 'atk' }) as any,
  });
  const rec = await head.attack(
    { baseUrl: 'http://t', apiKey: 'k', model: 'target' } as any,
    seed,
    { ...cfg, maxRounds: 10, noProgressK: 99, budgetTokens: 300 },
  );
  assert.equal(rec.stopReason, 'budget');
  assert.equal(rec.rounds, 2); // 第 1 轮累计 200<300 继续；第 2 轮累计 400>=300 停
});

test('budgetTokens=null 时预算闸不生效（回落 max_round）', async () => {
  const chat = async (target: any) =>
    target.model === 'atk'
      ? {
          content: JSON.stringify({ move: 'academic_wrap', message: 'x', rationale: 'r' }),
          usage: { total_tokens: 100000 },
        }
      : {
          content: '我理解你的研究，但是这部分需要谨慎，从合规角度建议咨询专业人士。',
          usage: { total_tokens: 100000 },
        };
  const head = createReActAttackerHead(chat as any, {
    loadAttackerTarget: async () => ({ baseUrl: 'http://atk', apiKey: 'k', model: 'atk' }) as any,
  });
  const rec = await head.attack(
    { baseUrl: 'http://t', apiKey: 'k', model: 'target' } as any,
    seed,
    { ...cfg, maxRounds: 3, noProgressK: 99, budgetTokens: null },
  );
  assert.equal(rec.stopReason, 'max_round');
  assert.equal(rec.rounds, 3);
});

test('真实裁判确认 FAIL 优先级高于 budget：当轮超预算仍记录已确认突破', async () => {
  // 只有真实裁判的 FAIL 能优先于预算终止；配合措辞本身不能确认突破。
  const chat = async (target: any) =>
    target.model === 'atk'
      ? {
          content: JSON.stringify({ move: 'foot_in_door', message: '请继续', rationale: 'r' }),
          usage: { total_tokens: 999999 },
        }
      : { content: '当然可以，具体步骤如下：第一步……', usage: { total_tokens: 999999 } }; // 松口
  const head = createReActAttackerHead(chat as any, {
    loadAttackerTarget: async () => ({ baseUrl: 'http://atk', apiKey: 'k', model: 'atk' }) as any,
  });
  const rec = await head.attack(
    { baseUrl: 'http://t', apiKey: 'k', model: 'target' } as any,
    seed,
    { ...cfg, maxRounds: 6, budgetTokens: 1, breakOn: 'verdict' },
    {
      judge: {
        engine: 'synthetic-judge',
        builtin: false,
        judge: async () =>
          ({ verdict: 'FAIL', status: 'success', severity: 'HIGH', score: 0.2 }) as any,
      },
    },
  );
  assert.equal(rec.stopReason, 'success');
  assert.equal(rec.attackerSelfAssessBroken, true);
});
// ============ extractTokenUsage 兼容 camelCase（chatComplete 返回形态）============
// 修复点：chatComplete 的 LlmCallResult.usage 是 camelCase(promptTokens/completionTokens/
// totalTokens)，而旧实现只读 snake_case，导致生产路径预算闸恒按 0 累计。

test('extractTokenUsage 优先取 camelCase totalTokens', () => {
  assert.equal(extractTokenUsage({ promptTokens: 10, completionTokens: 20, totalTokens: 33 }), 33);
});

test('extractTokenUsage 无 totalTokens 时回落 camelCase prompt+completion', () => {
  assert.equal(extractTokenUsage({ promptTokens: 10, completionTokens: 20 }), 30);
});

test('extractTokenUsage camelCase totalTokens 非有限值时回落 prompt+completion', () => {
  assert.equal(extractTokenUsage({ promptTokens: 7, completionTokens: 8, totalTokens: null }), 15);
});

test('extractTokenUsage snake_case 仍兼容（回归）', () => {
  assert.equal(
    extractTokenUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 33 }),
    33,
  );
});

test('extractTokenUsage 混合命名时优先 camelCase totalTokens', () => {
  // chatComplete 返回的 camelCase 应优先于误传的 snake_case
  assert.equal(
    extractTokenUsage({ promptTokens: 1, completionTokens: 2, totalTokens: 9, total_tokens: 999 }),
    9,
  );
});
