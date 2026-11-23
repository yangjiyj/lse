import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSubstanceJudge } from '../src/modules/red-team/substance-judge.js';
import { createRedTeamChat } from '../src/modules/red-team/red-team-chat.js';
import { AdaptiveConcurrency } from '../src/modules/red-team/adaptive-concurrency.js';
import { AsyncSemaphore } from '../src/modules/red-team/async-semaphore.js';
import { RetryExhausted, ConfigError } from '../src/modules/red-team/red-team-chat.js';

// P4：substance judge 必须走 RedTeamChat(stage=judge, judgeMaxTokens=512 透传)，
// 参与任务级自适应恢复。503/空content 原轮重试；401 不重试抛 ConfigError；
// retryable 耗尽抛 RetryExhausted 让上层停止后续。裁判失败绝不伪造 PASS/FAIL。

function rtWith(seq: any[]) {
  let i = 0;
  const calls: any[] = [];
  const chat = async (_t: any, _m: any, opts: any) => {
    calls.push(opts);
    const r = seq[Math.min(i, seq.length - 1)];
    i++;
    return r;
  };
  const controller = new AdaptiveConcurrency(4);
  const rt = createRedTeamChat({
    chat: chat as any,
    controller,
    semaphore: new AsyncSemaphore(4),
    sleep: () => Promise.resolve(),
  });
  return { rt, calls, controller };
}

test('judge 首次 503、第二次成功 → 最终给出 verdict（非伪造）', async () => {
  const { rt, calls } = rtWith([
    { status: 'ERROR', content: '', httpStatus: 503, error: 'HTTP 503' },
    {
      status: 'SUCCESS',
      content: '{"verdict":"PASS","severity":"INFO","score":0.9,"reason":"无实质危害"}',
      finishReason: 'stop',
      httpStatus: 200,
      usage: {},
    },
  ]);
  const judge = makeSubstanceJudge({ baseUrl: 'u', apiKey: 'k', model: 'j' } as any, rt, 512);
  const r = await judge.judge({
    taskId: 't',
    questionId: 'q',
    prompt: 'p',
    response: '正文无危害',
  } as any);
  assert.equal(r.verdict, 'PASS');
  assert.equal(calls.length, 2); // 503 后重试一次
  assert.equal(calls[0].maxTokens, 512); // judgeMaxTokens 透传
});

test('judge 连续 503 耗尽 → 抛 RetryExhausted（不伪造 PASS/FAIL）', async () => {
  const { rt } = rtWith([
    { status: 'ERROR', content: '', httpStatus: 503, error: 'HTTP 503' },
    { status: 'ERROR', content: '', httpStatus: 503, error: 'HTTP 503' },
    { status: 'ERROR', content: '', httpStatus: 503, error: 'HTTP 503' },
  ]);
  const judge = makeSubstanceJudge({ baseUrl: 'u', apiKey: 'k', model: 'j' } as any, rt, 512);
  await assert.rejects(
    () => judge.judge({ taskId: 't', questionId: 'q', prompt: 'p', response: 'r' } as any),
    (e: unknown) => e instanceof RetryExhausted,
  );
});

test('judge 连续空 content 耗尽 → 抛 RetryExhausted', async () => {
  const { rt } = rtWith([
    { status: 'SUCCESS', content: '', finishReason: 'stop', httpStatus: 200, usage: {} },
    { status: 'SUCCESS', content: '   ', finishReason: 'stop', httpStatus: 200, usage: {} },
    { status: 'SUCCESS', content: '', finishReason: 'stop', httpStatus: 200, usage: {} },
  ]);
  const judge = makeSubstanceJudge({ baseUrl: 'u', apiKey: 'k', model: 'j' } as any, rt, 512);
  await assert.rejects(
    () => judge.judge({ taskId: 't', questionId: 'q', prompt: 'p', response: 'r' } as any),
    (e: unknown) => e instanceof RetryExhausted,
  );
});

test('judge 401 → 抛 ConfigError，只调用一次', async () => {
  const { rt, calls } = rtWith([
    { status: 'ERROR', content: '', httpStatus: 401, error: 'HTTP 401' },
  ]);
  const judge = makeSubstanceJudge({ baseUrl: 'u', apiKey: 'k', model: 'j' } as any, rt, 512);
  await assert.rejects(
    () => judge.judge({ taskId: 't', questionId: 'q', prompt: 'p', response: 'r' } as any),
    (e: unknown) => e instanceof ConfigError && (e as ConfigError).stage === 'judge',
  );
  assert.equal(calls.length, 1);
});

test('judge maxTokens 默认 512（未显式传时）', async () => {
  const { rt, calls } = rtWith([
    {
      status: 'SUCCESS',
      content: '{"verdict":"PASS","severity":"INFO","score":0.9,"reason":"ok"}',
      finishReason: 'stop',
      httpStatus: 200,
      usage: {},
    },
  ]);
  const judge = makeSubstanceJudge({ baseUrl: 'u', apiKey: 'k', model: 'j' } as any, rt);
  await judge.judge({ taskId: 't', questionId: 'q', prompt: 'p', response: 'r' } as any);
  assert.equal(calls[0].maxTokens, 512);
});
