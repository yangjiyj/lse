import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChatError } from '../src/modules/red-team/chat-error.js';

// classifyChatError(result)：把一次模型调用归一化结果折算成
//   { retryable: boolean; reasonCode: string; httpStatus: number | null }
// 规则（与 spec「错误分类」一致）：
//   retryable:
//     - fetch failed / AbortError / 超时（status=ERROR 且 error 含网络/超时特征，httpStatus=null）
//     - HTTP 429 / 502 / 503 / 504
//     - HTTP 200 但 content 为空/null/纯空白
//   non-retryable:
//     - HTTP 400 / 401 / 403 / 404（配置错误，不得靠降并发掩盖）
//     - 响应缺少 choices（协议/配置错误）

function ok(content = '正常回答', finishReason: string | null = 'stop') {
  return { status: 'SUCCESS' as const, content, finishReason, httpStatus: 200, error: null };
}

// ---------- retryable ----------

test('fetch failed 归类 retryable / NETWORK', () => {
  const r = classifyChatError({
    status: 'ERROR',
    content: '',
    httpStatus: null,
    error: '网络/连接错误：fetch failed',
  } as any);
  assert.equal(r.retryable, true);
  assert.equal(r.reasonCode, 'NETWORK');
});

test('AbortError 超时归类 retryable / TIMEOUT', () => {
  const r = classifyChatError({
    status: 'ERROR',
    content: '',
    httpStatus: null,
    error: '请求超时（>60000ms）',
  } as any);
  assert.equal(r.retryable, true);
  assert.equal(r.reasonCode, 'TIMEOUT');
});

test('HTTP 429 归类 retryable / HTTP_429', () => {
  const r = classifyChatError({
    status: 'ERROR',
    content: '',
    httpStatus: 429,
    error: '模型接口返回错误：rate limit',
  } as any);
  assert.equal(r.retryable, true);
  assert.equal(r.reasonCode, 'HTTP_429');
});

for (const sc of [502, 503, 504]) {
  test(`HTTP ${sc} 归类 retryable / HTTP_5xx`, () => {
    const r = classifyChatError({
      status: 'ERROR',
      content: '',
      httpStatus: sc,
      error: `HTTP ${sc}`,
    } as any);
    assert.equal(r.retryable, true);
    assert.equal(r.reasonCode, 'HTTP_5XX');
  });
}

test('HTTP 200 但 content 为空归类 retryable / EMPTY_CONTENT', () => {
  const r = classifyChatError(ok('', 'stop'));
  assert.equal(r.retryable, true);
  assert.equal(r.reasonCode, 'EMPTY_CONTENT');
});

test('HTTP 200 但 content 为纯空白归类 retryable / EMPTY_CONTENT', () => {
  const r = classifyChatError(ok('   \n\t  ', null));
  assert.equal(r.retryable, true);
  assert.equal(r.reasonCode, 'EMPTY_CONTENT');
});

test('HTTP 200 空正文且 length 截断归类 retryable / TOKEN_BUDGET_EXHAUSTED', () => {
  const r = classifyChatError(ok('', 'length'));
  assert.equal(r.retryable, true);
  assert.equal(r.reasonCode, 'TOKEN_BUDGET_EXHAUSTED');
  assert.equal(r.httpStatus, 200);
});

// ---------- non-retryable ----------

test('HTTP 400 context exhaustion is scenario-scoped', () => {
  const r = classifyChatError({
    status: 'ERROR',
    content: '',
    httpStatus: 400,
    error: 'request (4136 tokens) exceeds the available context size (4096 tokens)',
  } as any);
  assert.equal(r.retryable, false);
  assert.equal(r.reasonCode, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(r.httpStatus, 400);
});
for (const sc of [400, 401, 403, 404]) {
  test(`HTTP ${sc} 归类 non-retryable / HTTP_4XX（配置错误，不降并发轰击）`, () => {
    const r = classifyChatError({
      status: 'ERROR',
      content: '',
      httpStatus: sc,
      error: `HTTP ${sc}`,
    } as any);
    assert.equal(r.retryable, false);
    assert.equal(r.reasonCode, 'HTTP_4XX');
    assert.equal(r.httpStatus, sc);
  });
}

test('响应缺少 choices 归类 non-retryable / MISSING_CHOICES', () => {
  const r = classifyChatError({
    status: 'ERROR',
    content: '',
    httpStatus: 200,
    error: '模型响应缺少 choices 字段',
  } as any);
  assert.equal(r.retryable, false);
  assert.equal(r.reasonCode, 'MISSING_CHOICES');
});

// ---------- 正常成功不触发任何错误分类 ----------

test('正常成功回答（非空 content）retryable=false 且 reasonCode=OK', () => {
  const r = classifyChatError(ok('这是正常回答', 'stop'));
  assert.equal(r.retryable, false);
  assert.equal(r.reasonCode, 'OK');
});

test('finish_reason=length 的非空 content 视为成功（资源消耗证据，非异常）', () => {
  const r = classifyChatError(ok('被截断的长回答…', 'length'));
  assert.equal(r.retryable, false);
  assert.equal(r.reasonCode, 'OK');
});
