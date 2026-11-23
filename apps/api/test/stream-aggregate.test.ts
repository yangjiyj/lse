import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateStream,
  detectStreamFormat,
  parseStreamEvents,
} from '../src/lib/stream-aggregate.js';

test('detectStreamFormat：按 Content-Type 与正文形态识别 SSE / NDJSON', () => {
  assert.equal(detectStreamFormat('text/event-stream; charset=utf-8', ''), 'sse');
  assert.equal(detectStreamFormat('application/x-ndjson', ''), 'ndjson');
  assert.equal(detectStreamFormat('application/json', '{"a":1}'), null);
  assert.equal(detectStreamFormat('application/json', '{"a":1}\n{"a":2}\n'), 'ndjson');
  assert.equal(detectStreamFormat('text/plain', 'data: {"x":1}\n\n'), 'sse');
  assert.equal(detectStreamFormat(null, 'hello'), null);
});

test('OpenAI 兼容 SSE：拼接 choices[0].delta.content，忽略 [DONE] 与注释行', () => {
  const body = [
    ': keep-alive',
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"你好"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"，世界"}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const out = aggregateStream(body, 'sse');
  assert.equal(out.text, '你好，世界');
  assert.equal(out.textPath, 'choices[0].delta.content');
  assert.equal(out.events.length, 3);
});

test('Dify 风格 SSE：message 事件增量拼接，结束事件携带全文时不重复', () => {
  const body = [
    'event: message',
    'data: {"event":"message","answer":"风险","conversation_id":"c-1"}',
    '',
    'data: {"event":"message","answer":"已拦截","conversation_id":"c-1"}',
    '',
    'data: {"event":"message_end","answer":"风险已拦截","conversation_id":"c-1"}',
    '',
  ].join('\r\n');
  const out = aggregateStream(body, 'sse');
  assert.equal(out.text, '风险已拦截');
  assert.deepEqual(out.lastJsonEvent, {
    event: 'message_end',
    answer: '风险已拦截',
    conversation_id: 'c-1',
  });
});

test('Ollama 风格 NDJSON：拼接 message.content', () => {
  const body =
    '{"message":{"role":"assistant","content":"A"},"done":false}\n' +
    '{"message":{"role":"assistant","content":"B"},"done":false}\n' +
    '{"message":{"role":"assistant","content":""},"done":true}\n';
  const out = aggregateStream(body, 'ndjson');
  assert.equal(out.text, 'AB');
  assert.equal(out.textPath, 'message.content');
});

test('配置的响应字段路径优先；无文本增量时 text 为 null', () => {
  const body = 'data: {"payload":{"t":"x"}}\n\ndata: {"payload":{"t":"y"}}\n\n';
  assert.equal(aggregateStream(body, 'sse', 'payload.t').text, 'xy');
  assert.equal(aggregateStream('data: {"id":1}\n\n', 'sse').text, null);
});

test('多行 data 字段按 SSE 规范以换行拼接，非 JSON 数据按原文拼接', () => {
  const events = parseStreamEvents('data: 第一行\ndata: 第二行\n\n', 'sse');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.data, '第一行\n第二行');
  assert.equal(aggregateStream('data: 甲\n\ndata: 乙\n\n', 'sse').text, '甲乙');
});
