import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRedTeamAttack } from '../src/modules/red-team/pipe.js';
import { createRedTeamChat } from '../src/modules/red-team/red-team-chat.js';
import { AdaptiveConcurrency } from '../src/modules/red-team/adaptive-concurrency.js';
import { RedTeamExecutionError } from '../src/modules/red-team/execution-error.js';
const seed = {
  questionId: 'q1',
  content: 'g',
  category: null,
  expectedBehavior: null,
  referenceAnswer: null,
  shouldRefuse: true,
  severity: null,
  questionType: 'SHOULD_REFUSE',
} as any;
const cfg = {
  moves: [],
  maxRounds: 6,
  noProgressK: 3,
  budgetTokens: null,
  gatewayTargetId: '',
  attackerTargetId: 'atk',
} as any;

function dummyHead() {
  return {
    name: 'dummy' as const,
    async attack() {
      return {
        seedId: 'q1',
        attackerTurns: [{ move: 'academic_wrap' as const, message: 'm1' }],
        transcript: [],
        movesUsed: ['academic_wrap'],
        rounds: 1,
        stopReason: 'max_round' as const,
        attackerSelfAssessBroken: false,
      };
    },
  } as any;
}
function passJudge() {
  return {
    engine: 'llm-judge',
    async judge(input: any) {
      return {
        engine: 'llm-judge',
        taskId: input.taskId,
        questionId: input.questionId,
        status: 'success',
        riskCategory: 'jail',
        severity: 'INFO',
        score: 0.9,
        verdict: 'PASS',
        evidence: null,
        rawOutput: {},
        startedAt: '',
        endedAt: '',
      };
    },
  } as any;
}

test('replay 注入 RedTeamChat：空响应被重试，最终拿到非空回答', async () => {
  let i = 0;
  const chat = async () => {
    const r =
      i === 0
        ? { status: 'SUCCESS', content: '', finishReason: 'stop', httpStatus: 200, usage: {} }
        : {
            status: 'SUCCESS',
            content: '正常重放回答',
            finishReason: 'stop',
            httpStatus: 200,
            usage: {},
          };
    i++;
    return r;
  };
  const rt = createRedTeamChat({
    chat: chat as any,
    controller: new AdaptiveConcurrency(4),
    sleep: () => Promise.resolve(),
  });
  const pair = await runRedTeamAttack({
    task: { id: 't1', modelTargetId: 'mtA' },
    bareTarget: { baseUrl: 'http://a', apiKey: 'k', model: 'bare' } as any,
    seed,
    cfg,
    head: dummyHead(),
    deps: {
      chat: chat as any,
      judge: passJudge(),
      loadTarget: async () => ({ baseUrl: 'u', apiKey: 'k', model: 'x' }) as any,
      redTeamChat: rt,
      targetMaxTokens: 1024,
    },
    controlGroupId: 'cg',
  } as any);
  assert.equal(pair.sideA.response, '正常重放回答');
});

test('replay 注入 RedTeamChat：maxTokens 透传到调用', async () => {
  let seenMaxTokens: unknown = undefined;
  const chat = async (_t: any, _m: any, opts: any) => {
    seenMaxTokens = opts?.maxTokens;
    return { status: 'SUCCESS', content: 'ok', finishReason: 'stop', httpStatus: 200, usage: {} };
  };
  const rt = createRedTeamChat({
    chat: chat as any,
    controller: new AdaptiveConcurrency(4),
    sleep: () => Promise.resolve(),
  });
  await runRedTeamAttack({
    task: { id: 't1', modelTargetId: 'mtA' },
    bareTarget: { baseUrl: 'http://a', apiKey: 'k', model: 'bare' } as any,
    seed,
    cfg,
    head: dummyHead(),
    deps: {
      chat: chat as any,
      judge: passJudge(),
      loadTarget: async () => ({ baseUrl: 'u', apiKey: 'k', model: 'x' }) as any,
      redTeamChat: rt,
      targetMaxTokens: 1024,
    },
    controlGroupId: 'cg',
  } as any);
  assert.equal(seenMaxTokens, 1024);
});

test('replay finish_reason=length 写入 recording 的侧别与轮次', async () => {
  const chat = async () => ({
    status: 'SUCCESS',
    content: '截断回答',
    finishReason: 'length',
    httpStatus: 200,
    usage: {},
  });
  const rt = createRedTeamChat({ chat: chat as any, controller: new AdaptiveConcurrency(1) });
  const pair = await runRedTeamAttack({
    task: { id: 't1', modelTargetId: 'mtA' },
    bareTarget: { baseUrl: 'http://a', apiKey: 'k', model: 'bare' } as any,
    seed,
    cfg,
    head: dummyHead(),
    deps: {
      chat: chat as any,
      judge: passJudge(),
      loadTarget: async () => ({ baseUrl: 'u', apiKey: 'k', model: 'x' }) as any,
      redTeamChat: rt,
    },
    controlGroupId: 'cg',
  } as any);
  assert.deepEqual(pair.recording.lengthTruncations, [{ stage: 'replay', round: 1, side: 'A' }]);
});
test('录制标记 infraIncomplete 时立即终止，不进入 replay 或 judge', async () => {
  let replayCalls = 0;
  let judgeCalls = 0;
  const incompleteHead = {
    name: 'legacy-incomplete',
    async attack() {
      return {
        seedId: 'q1',
        attackerTurns: [{ move: 'academic_wrap', message: 'm1' }],
        transcript: [],
        movesUsed: ['academic_wrap'],
        rounds: 0,
        stopReason: 'infra_error',
        attackerSelfAssessBroken: false,
        infraIncomplete: true,
        errorType: 'INFRASTRUCTURE_INCOMPLETE',
      };
    },
  };

  await assert.rejects(
    () =>
      runRedTeamAttack({
        task: { id: 't1', modelTargetId: 'mtA' },
        bareTarget: { baseUrl: 'http://a', apiKey: 'k', model: 'bare' } as any,
        seed,
        cfg,
        head: incompleteHead as any,
        deps: {
          chat: async () => {
            replayCalls += 1;
            return { content: '不应调用' } as any;
          },
          judge: {
            engine: 'llm-judge',
            async judge() {
              judgeCalls += 1;
              return {} as any;
            },
          },
          loadTarget: async () => ({ baseUrl: 'u', apiKey: 'k', model: 'x' }) as any,
        },
        controlGroupId: 'cg',
      } as any),
    (error: unknown) => (error as Error).name === 'RedTeamInfrastructureError',
  );
  assert.equal(replayCalls, 0);
  assert.equal(judgeCalls, 0);
});

test('P3：旧chat返回ERROR也必须停止后续replay、judge与网关回查', async () => {
  let calls = 0,
    judges = 0,
    gateway = 0;
  await assert.rejects(
    () =>
      runRedTeamAttack({
        task: { id: 't', modelTargetId: 'a' },
        bareTarget: {} as any,
        seed,
        cfg: { ...cfg, gatewayTargetId: 'b' },
        head: dummyHead(),
        controlGroupId: 'pair',
        deps: {
          chat: async () => {
            calls++;
            return { status: 'ERROR', content: '', error: 'ECONNREFUSED' } as any;
          },
          judge: {
            judge: async () => {
              judges++;
              return { verdict: 'PASS' };
            },
          } as any,
          loadTarget: async () => ({}) as any,
          collectGatewayEvidence: async () => {
            gateway++;
            return { gatewayRecognizedRisk: false };
          },
        },
      }),
    (error: any) => error.name === 'RedTeamInfrastructureError',
  );
  assert.equal(calls, 1);
  assert.equal(judges, 0);
  assert.equal(gateway, 0);
});
test('P7：A侧已截断后B侧infra失败，截断侧别轮次仍随错误保留', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runRedTeamAttack({
        task: { id: 't', modelTargetId: 'a' },
        bareTarget: {} as any,
        seed,
        cfg: { ...cfg, gatewayTargetId: 'b' },
        head: dummyHead(),
        controlGroupId: 'pair',
        deps: {
          chat: async () => {
            if (++calls === 1)
              return { status: 'SUCCESS', content: '截断文本', finishReason: 'length' } as any;
            throw new Error('infra unavailable');
          },
          judge: passJudge(),
          loadTarget: async () => ({}) as any,
        },
      }),
    (error: any) => {
      assert.deepEqual(error.lengthTruncations, [{ stage: 'replay', round: 1, side: 'A' }]);
      return true;
    },
  );
});

for (const wrapped of [false, true]) {
  test(`length截断且内容为空仍保留证据并停止judge（包装器=${wrapped}）`, async () => {
    let judges = 0;
    const empty = async () => ({ status: 'SUCCESS' as const, content: '', finishReason: 'length' });
    await assert.rejects(
      runRedTeamAttack({
        task: { id: 't', modelTargetId: 'a' },
        bareTarget: {} as any,
        seed,
        cfg,
        head: dummyHead(),
        controlGroupId: 'pair',
        deps: {
          chat: empty,
          judge: {
            judge: async () => {
              judges++;
              return {} as any;
            },
          } as any,
          loadTarget: async () => ({}) as any,
          ...(wrapped ? { redTeamChat: { call: empty } as any } : {}),
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof RedTeamExecutionError);
        assert.equal(error.stage, 'replay');
        assert.equal(error.reasonCode, 'REPLAY_CALL_FAILED');
        assert.deepEqual(error.lengthTruncations, [{ stage: 'replay', round: 1, side: 'A' }]);
        return true;
      },
    );
    assert.equal(judges, 0);
  });
}
test('typed异常保留调度类别和结构化字段，剔除不合法截断字段', () => {
  const source = {
    name: 'RetryExhausted',
    message: 'synthetic',
    stage: 'judge',
    attempts: 3,
    lastReasonCode: 'HTTP_5XX',
    lengthTruncations: [
      { stage: 'target', round: 1, side: 'A', secret: 'discard' },
      { stage: 'bad', round: 0 },
    ],
  };
  const error = RedTeamExecutionError.from(source);
  assert.equal(error.name, 'RetryExhausted');
  assert.equal(error.stage, 'judge');
  assert.equal(error.attempts, 3);
  assert.equal(error.lastReasonCode, 'HTTP_5XX');
  assert.deepEqual(error.lengthTruncations, [{ stage: 'target', round: 1, side: 'A' }]);
  assert.equal(RedTeamExecutionError.from(null).reasonCode, 'UNKNOWN');
});

test('typed异常保留配置与取消类别，拒绝畸形截断元数据', () => {
  for (const name of ['ConfigError', 'AbortError'])
    assert.equal(
      RedTeamExecutionError.from({
        name,
        stage: 'attacker',
        reasonCode: 'CONFIG_ERROR',
        attempts: 1,
      }).name,
      name,
    );
  const invalid = [
    null,
    {},
    { stage: 'replay', round: '1' },
    { stage: 'target', round: 0 },
    { stage: 'attacker', round: 1.5 },
  ];
  assert.deepEqual(
    RedTeamExecutionError.from({ lengthTruncations: invalid }).lengthTruncations,
    [],
  );
  assert.deepEqual(
    RedTeamExecutionError.from({ lengthTruncations: 'invalid' }).lengthTruncations,
    [],
  );
  assert.deepEqual(
    RedTeamExecutionError.from({
      lengthTruncations: [{ stage: 'target', round: 1, side: 'invalid' }],
    }).lengthTruncations,
    [{ stage: 'target', round: 1 }],
  );
});
