import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeProbeResponse,
  type DiagnoseTargetShape,
} from '../src/modules/model-targets/diagnose.js';

const agent: DiagnoseTargetShape = {
  targetType: 'AGENT_API',
  hasApiKey: true,
  responseTextPath: 'data.answer',
  sessionHeaderName: null,
  templateUsesSessionId: false,
};

function check(report: ReturnType<typeof analyzeProbeResponse>, key: string) {
  const found = report.checks.find((c) => c.key === key);
  assert.ok(found, `缺少检查项 ${key}`);
  return found;
}

test('401/403 判定为认证失败并给出中文建议', () => {
  for (const status of [401, 403]) {
    const r = analyzeProbeResponse(agent, {
      httpStatus: status,
      contentType: 'application/json',
      text: '{"message":"invalid token"}',
    });
    assert.equal(r.ok, false);
    assert.equal(check(r, 'auth').status, 'fail');
    assert.match(check(r, 'auth').message, /认证失败/);
    assert.ok(check(r, 'auth').suggestion);
  }
});

test('正常 JSON 响应：认证/流式/异步/会话/字段全部通过', () => {
  const r = analyzeProbeResponse(agent, {
    httpStatus: 200,
    contentType: 'application/json',
    text: JSON.stringify({ data: { answer: '您好' } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.answerSample, '您好');
  for (const key of ['network', 'auth', 'stream', 'async', 'session', 'field']) {
    assert.equal(check(r, key).status, 'pass', key);
  }
});

test('SSE 流式响应被识别并聚合，NDJSON 同理', () => {
  const sse = analyzeProbeResponse(
    { ...agent, responseTextPath: 'answer' },
    {
      httpStatus: 200,
      contentType: 'text/event-stream',
      text: 'data: {"answer":"甲"}\n\ndata: {"answer":"乙"}\n\n',
    },
  );
  assert.equal(sse.streamFormat, 'sse');
  assert.equal(sse.answerSample, '甲乙');
  assert.equal(check(sse, 'stream').status, 'pass');
  assert.match(check(sse, 'stream').message, /SSE/);
  const nd = analyzeProbeResponse(
    { ...agent, responseTextPath: 'response' },
    {
      httpStatus: 200,
      contentType: 'application/x-ndjson',
      text: '{"response":"A"}\n{"response":"B"}\n',
    },
  );
  assert.equal(nd.streamFormat, 'ndjson');
  assert.equal(nd.answerSample, 'AB');
});

test('模型接口返回流式响应时提示移除 stream 参数', () => {
  const r = analyzeProbeResponse(
    { ...agent, targetType: 'MODEL', responseTextPath: null },
    {
      httpStatus: 200,
      contentType: 'text/event-stream',
      text: 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n',
    },
  );
  assert.equal(check(r, 'stream').status, 'fail');
  assert.match(check(r, 'stream').suggestion ?? '', /stream/);
});

test('响应含 task_id 与 pending 状态时提示异步轮询', () => {
  const r = analyzeProbeResponse(agent, {
    httpStatus: 202,
    contentType: 'application/json',
    text: JSON.stringify({ task_id: 't-1', status: 'pending' }),
  });
  assert.equal(check(r, 'async').status, 'warn');
  assert.match(check(r, 'async').message, /异步/);
});

test('响应含 conversation_id 且未配置会话请求头时提示固定会话；配置后通过', () => {
  const resp = {
    httpStatus: 200,
    contentType: 'application/json',
    text: JSON.stringify({ answer: 'ok', conversation_id: 'c-9' }),
  };
  const r = analyzeProbeResponse({ ...agent, responseTextPath: 'answer' }, resp);
  assert.equal(r.detectedSessionField, 'conversation_id');
  assert.equal(check(r, 'session').status, 'warn');
  assert.match(check(r, 'session').suggestion ?? '', /会话请求头/);
  const configured = analyzeProbeResponse(
    { ...agent, responseTextPath: 'answer', sessionHeaderName: 'X-Conversation-Id' },
    resp,
  );
  assert.equal(check(configured, 'session').status, 'pass');
});

test('配置的响应字段不存在时报字段缺失并给出候选路径', () => {
  const r = analyzeProbeResponse(
    { ...agent, responseTextPath: 'data.reply' },
    {
      httpStatus: 200,
      contentType: 'application/json',
      text: JSON.stringify({ result: { text: '真正的回答内容' } }),
    },
  );
  assert.equal(r.ok, false);
  assert.equal(check(r, 'field').status, 'fail');
  assert.match(check(r, 'field').message, /字段缺失/);
  assert.deepEqual(r.responseCandidates, ['result.text']);
});

test('配置路径缺失但默认路径命中时给警告并提示实际路径', () => {
  const r = analyzeProbeResponse(
    { ...agent, responseTextPath: 'data.reply' },
    { httpStatus: 200, contentType: 'application/json', text: JSON.stringify({ answer: '回答' }) },
  );
  assert.equal(check(r, 'field').status, 'warn');
  assert.equal(r.answerSample, '回答');
  assert.ok(r.responseCandidates.includes('answer'));
});

test('响应预览中的凭据被遮蔽', () => {
  const secret = ['sk', 'leak', 'Zzz1112223334445556'].join('-');
  const r = analyzeProbeResponse(agent, {
    httpStatus: 500,
    contentType: 'application/json',
    text: JSON.stringify({ message: `bad key ${secret}` }),
  });
  assert.ok(!JSON.stringify(r).includes(secret));
});
