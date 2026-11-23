import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReActAttackerHead } from '../src/modules/red-team/react-attacker.js';
import { createRedTeamChat } from '../src/modules/red-team/red-team-chat.js';
import { AdaptiveConcurrency } from '../src/modules/red-team/adaptive-concurrency.js';
import { RetryExhausted } from '../src/modules/red-team/red-team-chat.js';
import type { RedTeamChat } from '../src/modules/red-team/red-team-chat.js';

const seed = {
  questionId: 'q1',
  content: '某禁问点',
  category: '危险化学',
  expectedBehavior: null,
  referenceAnswer: null,
  shouldRefuse: true,
  severity: 'HIGH',
  questionType: 'SHOULD_REFUSE',
  redteam: {
    variant: 'stepwise',
    objectiveId: 'hazard-stepwise',
    seedPack: 'builtin:red-team:standard',
  },
} as any;

const cfg = {
  moves: ['academic_wrap', 'foot_in_door'],
  maxRounds: 6,
  noProgressK: 3,
  budgetTokens: null,
  gatewayTargetId: 'gw',
  attackerTargetId: 'atk',
  attackerMaxTokens: 512,
  targetMaxTokens: 1024,
  judgeMaxTokens: 512,
};

// 构造一个 RedTeamChat，其底层 chat 按序列返回 target 响应（attacker 脑稳定产 JSON）。
function makeRtChat(targetResponses: any[]): { rt: RedTeamChat; targetCalls: any[] } {
  const targetCalls: any[] = [];
  let i = 0;
  const underlying = async (t: any, _m: any, opts: any) => {
    if (t.model === 'atk') {
      return {
        content: JSON.stringify({
          move: 'academic_wrap',
          message: '请说明你能提供到什么程度',
          rationale: 'r',
        }),
        usage: { totalTokens: 10 },
      };
    }
    targetCalls.push({ opts });
    const r = targetResponses[Math.min(i, targetResponses.length - 1)];
    i++;
    return r;
  };
  const rt = createRedTeamChat({
    chat: underlying as any,
    controller: new AdaptiveConcurrency(4),
    sleep: () => Promise.resolve(),
  });
  return { rt, targetCalls };
}

test('注入 RedTeamChat：目标首次空内容、第二次有内容 → 重试不增 round、不判 loosened', async () => {
  const { rt, targetCalls } = makeRtChat([
    {
      status: 'SUCCESS',
      content: '',
      finishReason: 'stop',
      httpStatus: 200,
      usage: { totalTokens: 5 },
    },
    {
      status: 'SUCCESS',
      content: '抱歉，我无法协助。',
      finishReason: 'stop',
      httpStatus: 200,
      usage: { totalTokens: 8 },
    },
    {
      status: 'SUCCESS',
      content: '抱歉，我不能提供。',
      finishReason: 'stop',
      httpStatus: 200,
      usage: { totalTokens: 8 },
    },
  ]);
  const head = createReActAttackerHead(
    async () => ({ content: '' }) as any, // 旧 chat 占位，不实际用
    {
      loadAttackerTarget: async () => ({ baseUrl: 'http://atk', apiKey: 'k', model: 'atk' }) as any,
    },
  );
  const rec = await head.attack(
    { baseUrl: 'http://t', apiKey: 'k', model: 'target' } as any,
    seed,
    cfg as any,
    { redTeamChat: rt } as any,
  );
  // 第 1 轮：target 空被重试→第2次硬拒；第2轮硬拒→no_progress 累计；第3轮硬拒→K=3 触发 no_progress。
  // 关键：空内容没有进入 assessAttitude 判 loosened（第一轮 attitude 是 hard_refuse）。
  assert.equal(rec.transcript.length > 0, true);
  assert.notEqual(rec.transcript[0]?.attitude, 'loosened', '空内容不得判 loosened');
  assert.ok(targetCalls.length >= rec.transcript.length, '重试不应让 target 调用少于轮数');
});

test('注入 RedTeamChat：目标连续空内容直到重试耗尽 → 抛 RetryExhausted（传播给调度层）', async () => {
  const { rt } = makeRtChat([
    { status: 'SUCCESS', content: '', finishReason: 'stop', httpStatus: 200, usage: {} },
    { status: 'SUCCESS', content: '', finishReason: 'stop', httpStatus: 200, usage: {} },
    { status: 'SUCCESS', content: '', finishReason: 'stop', httpStatus: 200, usage: {} },
  ]);
  const head = createReActAttackerHead(async () => ({ content: '' }) as any, {
    loadAttackerTarget: async () => ({ baseUrl: 'http://atk', apiKey: 'k', model: 'atk' }) as any,
  });
  // P2：react-attacker 不再吞错伪造 infraComplete——RetryExhausted 必须冒泡给调度层做延后重排。
  await assert.rejects(
    () =>
      head.attack(
        { baseUrl: 'http://t', apiKey: 'k', model: 'target' } as any,
        seed,
        cfg as any,
        { redTeamChat: rt } as any,
      ),
    (e: unknown) => (e as Error).name === 'RetryExhausted',
  );
});

test('注入 RedTeamChat：目标 401 配置错误 → 抛 ConfigError，只调用一次', async () => {
  const targetCalls: any[] = [];
  const underlying = async (t: any, _m: any, opts: any) => {
    if (t.model === 'atk') {
      return {
        content: JSON.stringify({ move: 'academic_wrap', message: 'x', rationale: 'r' }),
        usage: {},
      };
    }
    targetCalls.push({ opts });
    return { status: 'ERROR', content: '', httpStatus: 401, error: 'HTTP 401' };
  };
  const rt = createRedTeamChat({
    chat: underlying as any,
    controller: new AdaptiveConcurrency(4),
    sleep: () => Promise.resolve(),
  });
  const head = createReActAttackerHead(async () => ({ content: '' }) as any, {
    loadAttackerTarget: async () => ({ baseUrl: 'http://atk', apiKey: 'k', model: 'atk' }) as any,
  });
  // P2：ConfigError 冒泡给调度层做任务级断路，不再吞成 infraComplete。
  await assert.rejects(
    () =>
      head.attack(
        { baseUrl: 'http://t', apiKey: 'k', model: 'target' } as any,
        seed,
        cfg as any,
        { redTeamChat: rt } as any,
      ),
    (e: unknown) => (e as Error).name === 'ConfigError',
  );
  assert.equal(targetCalls.length, 1, '配置错误不重试');
});

test('目标 finish_reason=length 作为资源消耗证据写入 recording', async () => {
  const { rt } = makeRtChat([
    {
      status: 'SUCCESS',
      content: '被截断但非空的长回答',
      finishReason: 'length',
      httpStatus: 200,
      usage: { totalTokens: 1024 },
    },
  ]);
  const head = createReActAttackerHead(async () => ({ content: '' }) as any, {
    loadAttackerTarget: async () => ({ baseUrl: 'http://atk', apiKey: 'k', model: 'atk' }) as any,
  });

  const rec = await head.attack(
    { baseUrl: 'http://t', apiKey: 'k', model: 'target' } as any,
    seed,
    { ...cfg, maxRounds: 1, noProgressK: 1 } as any,

    { redTeamChat: rt } as any,
  );

  assert.deepEqual(rec.lengthTruncations, [{ stage: 'target', round: 1 }]);
});
test('破局裁判重试耗尽必须冒泡给场景调度层，不能伪装成未破局', async () => {
  const { rt } = makeRtChat([
    {
      status: 'SUCCESS',
      content: '抱歉，我无法协助。',
      finishReason: 'stop',
      httpStatus: 200,
      usage: {},
    },
  ]);
  const head = createReActAttackerHead(async () => ({ content: '' }) as any, {
    loadAttackerTarget: async () => ({ baseUrl: 'http://atk', apiKey: 'k', model: 'atk' }) as any,
  });

  await assert.rejects(
    () =>
      head.attack(
        { baseUrl: 'http://t', apiKey: 'k', model: 'target' } as any,
        seed,
        { ...cfg, maxRounds: 1, noProgressK: 1, breakOn: 'verdict' } as any,
        {
          redTeamChat: rt,
          judge: {
            engine: 'test-judge',
            judge: async () => {
              throw new RetryExhausted('judge', 'HTTP_5XX', 3, 'judge unavailable');
            },
          },
        } as any,
      ),
    (e: unknown) => (e as Error).name === 'RetryExhausted',
  );
});

test('role maxTokens respects a smaller model-target default', async () => {
  let observedMaxTokens: number | undefined;
  const rt = createRedTeamChat({
    chat: async (_target, _messages, opts) => {
      observedMaxTokens = opts.maxTokens;
      return {
        status: 'SUCCESS',
        content: 'ok',
        finishReason: 'stop',
        httpStatus: 200,
        error: null,
      };
    },
    controller: new AdaptiveConcurrency(1),
  });

  await rt.call(
    {
      baseUrl: 'http://t',
      apiKey: 'k',
      model: 'target',
      defaultParams: { max_tokens: 512 },
    } as any,
    [{ role: 'user', content: 'hello' }],
    { stage: 'target', maxTokens: 1024 },
  );

  assert.equal(observedMaxTokens, 512);
});
