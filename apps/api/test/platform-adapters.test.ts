import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDifySse } from '../src/modules/eval-targets/platform-adapters/dify.js';
import { parseCozeSse } from '../src/modules/eval-targets/platform-adapters/coze.js';
import { createPlatformAdapter, parsePlatformAppConfig } from '../src/modules/eval-targets/platform-adapters/index.js';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/platform-app/${name}.sse`, import.meta.url), 'utf8');

test('Dify 拆分多工具、节点、回答与用量', () => {
  const r = parseDifySse(fixture('dify'));
  assert.equal(r.text, '你好，欢迎');
  assert.equal(r.conversationId, 'dify-conv');
  assert.deepEqual(r.toolCalls.map(t => t.kind), ['tool', 'tool', 'tool', 'http', 'knowledge']);
  assert.deepEqual(r.toolCalls[1].arguments, { url: 'https://sink.example/page' });
  assert.equal(r.toolCalls[0].result, '12:00');
  assert.equal(r.usage?.promptTokens, 12);
  assert.equal(parseDifySse('data: {"event":"error","code":"bad","message":"失败"}\n\n').error?.code, 'bad');
});
test('Coze 关联函数调用结果并提取会话与用量', () => {
  const r = parseCozeSse(fixture('coze').replaceAll('\n', '\r\n'));
  assert.equal(r.text, '你好，欢迎');
  assert.equal(r.conversationId, 'coze-conv');
  assert.equal(r.toolCalls[0].result, '页面结果');
  assert.deepEqual(r.toolCalls[0].arguments, { url: 'https://sink.example' });
  assert.equal(r.usage?.completionTokens, 9);
  assert.equal(parseCozeSse('event: conversation.chat.failed\ndata: {"last_error":{"code":401,"msg":"失败"}}\n\n').error?.message, '失败');
});
test('截断结果并拒绝无完成事件或畸形 JSON，不能伪造成功', () => {
  const r = parseCozeSse('event: conversation.message.completed\ndata: {"type":"function_call","content":"broken"}\n\n');
  assert.ok(r.error);
  assert.ok(parseDifySse('data: {bad}\n\n').error);
  const long = fixture('coze').replace('页面结果', 'x'.repeat(20000));
  assert.ok(Buffer.byteLength(parseCozeSse(long).toolCalls[0].result!) <= 16384);
});
test('配置约束平台字段、协议与凭据', () => {
  assert.throws(() => parsePlatformAppConfig({ platform: 'coze', baseUrl: 'https://api.coze.cn' }));
  assert.throws(() => parsePlatformAppConfig({ platform: 'dify', baseUrl: 'file:///etc/passwd' }));
  assert.throws(() => parsePlatformAppConfig({ platform: 'dify', baseUrl: 'https://example.com/v1', inputs: { apiKey: 'app-secret' } }));
  assert.throws(() => parsePlatformAppConfig({ platform: 'dify', baseUrl: 'https://example.com/v1', inputs: { value: 'app-customerrealsecret123' } }));
});
test('Dify 请求与诊断回退，Coze 会话放 URL，工作流 query 放 inputs', async () => {
  const requests: {url: string; init: RequestInit}[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({url: String(url), init});
    if (url.endsWith('/info')) return new Response('', { status: 404 });
    if (url.endsWith('/parameters')) return new Response('{}');
    return new Response(fixture(url.includes('/v3/chat') ? 'coze' : 'dify'));
  };
  const dify = createPlatformAdapter(parsePlatformAppConfig({ platform: 'dify', baseUrl: 'https://example.com/v1', appMode: 'agent-chat', user: 'lse-eval-test' }), 'app-test', { fetch });
  assert.equal((await dify.diagnose()).ok, true);
  await dify.sendTurn({ message: '问题', conversationId: 'old' });
  assert.equal((requests[2].init.headers as Record<string,string>).authorization, 'Bearer app-test');
  assert.equal(requests[2].url, 'https://example.com/v1/chat-messages');
  assert.deepEqual(JSON.parse(String(requests[2].init.body)), { query: '问题', inputs: {}, response_mode: 'streaming', conversation_id: 'old', user: 'lse-eval-test' });
  const coze = createPlatformAdapter(parsePlatformAppConfig({ platform: 'coze', baseUrl: 'https://api.coze.cn', botId: 'bot-1' }), 'pat-test', { fetch });
  await coze.sendTurn({ message: '问题', conversationId: 'conv/1' });
  assert.match(requests[3].url, /conversation_id=conv%2F1/);
  assert.equal(JSON.parse(String(requests[3].init.body)).bot_id, 'bot-1');
  const workflow = createPlatformAdapter(parsePlatformAppConfig({ platform: 'dify', baseUrl: 'https://example.com/v1', appMode: 'workflow', inputs: { foo: 1 } }), 'app-test', { fetch });
  await workflow.sendTurn({ message: '任务', conversationId: null });
  assert.equal(requests[4].url, 'https://example.com/v1/workflows/run');
  assert.deepEqual(JSON.parse(String(requests[4].init.body)).inputs, { foo: 1, query: '任务' });
});
test('适配器对平台回显的应用密钥脱敏，传递取消与超时错误', async () => {
  const adapter = createPlatformAdapter(parsePlatformAppConfig({ platform: 'coze', baseUrl: 'https://api.coze.cn', botId: '1' }), 'pat-actual-secret', {
    fetch: async () => new Response(fixture('coze').replace('页面结果', 'pat-actual-secret')),
  });
  assert.ok(!JSON.stringify(await adapter.sendTurn({ message: 'hi', conversationId: null })).includes('pat-actual-secret'));
  const broken = createPlatformAdapter(parsePlatformAppConfig({ platform: 'coze', baseUrl: 'https://api.coze.cn', botId: '1' }), 'key', { fetch: async () => { throw new Error('timeout key'); } });
  assert.ok((await broken.sendTurn({ message: 'hi', conversationId: null })).error);
});

test('流响应头已到但响应体挂起时，取消必须终止读取并返回 UNKNOWN 所需错误', async () => {
  const ac = new AbortController();
  let cancelled = false;
  const adapter = createPlatformAdapter(parsePlatformAppConfig({platform:'coze',baseUrl:'https://api.coze.cn',botId:'1'}),'app-test',{
    fetch:async () => new Response(new ReadableStream({cancel(){cancelled=true;}})),
  });
  const timer = setTimeout(() => ac.abort(),10);
  const result = await Promise.race([adapter.sendTurn({message:'hi',conversationId:null,signal:ac.signal}),new Promise<null>(r => setTimeout(() => r(null),500))]);
  clearTimeout(timer);
  assert.ok(result?.error,'响应体挂起也必须响应取消');
  assert.equal(cancelled,true);
});

test('Dify 1.17.1 真实知识库和时间流按 id 合并且识别知识库', () => {
  const result = parseDifySse(fixture('dify-real-agent-chat-kb-time'));
  assert.equal(result.error, undefined);
  assert.equal(result.toolCalls.length, 2);
  assert.match(result.toolCalls[0].name, /^dataset_e9f8/);
  assert.equal(result.toolCalls[0].kind, 'knowledge');
  assert.match(result.toolCalls[0].result!, /LSE-CANARY-KB-7f3a91/);
  assert.equal(result.toolCalls[1].name, 'current_time');
  assert.equal(result.toolCalls[1].kind, 'tool');
  assert.ok(result.toolCalls.every(call => call.result));
});
test('Dify 1.17.1 真实抓取流只记录一次 fetch_url', () => {
  const result = parseDifySse(fixture('dify-real-agent-chat-fetch-url'));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.toolCalls.map(call => call.name), ['fetch_url']);
  assert.ok(result.toolCalls[0].result);
});
test('Dify 按 position 排序，同 id 多工具分别合并并补齐参数', () => {
  const thought = (data: object) => `data: ${JSON.stringify({event:'agent_thought', ...data})}\n\n`;
  const stream = thought({id:'b',position:2,tool:'time',tool_input:'{"time":{"zone":"UTC"}}'}) +
    thought({id:'a',position:1,tool:'dataset_AB12;fetch_url',tool_input:'{"fetch_url":{"url":"https://sink.example"}}'}) +
    thought({id:'b',position:2,tool:'time',observation:'{"time":"12:00"}'}) +
    thought({id:'a',position:1,tool:'dataset_AB12;fetch_url',observation:'{"dataset_AB12":"文档","fetch_url":"页面"}'}) +
    'data: {"event":"message_end"}\n\n';
  const result = parseDifySse(stream);
  assert.deepEqual(result.toolCalls.map(call => call.name), ['dataset_AB12','fetch_url','time']);
  assert.deepEqual(result.toolCalls.map(call => call.kind), ['knowledge','tool','tool']);
  assert.deepEqual(result.toolCalls[2].arguments, {zone:'UTC'});
  assert.deepEqual(result.toolCalls.map(call => call.result), ['文档','页面','12:00']);
});

test('平台配置允许含 app- 的内网域名，仅拒绝完整凭据值和凭据字段', () => {
  assert.doesNotThrow(() => parsePlatformAppConfig({platform:'dify',baseUrl:'http://dify-app-gateway-internal.corp/v1'}));
  assert.doesNotThrow(() => parsePlatformAppConfig({platform:'dify',baseUrl:'https://example.com',inputs:{service:'my-app-configuration-service'}}));
  assert.doesNotThrow(() => parsePlatformAppConfig({platform:'dify',baseUrl:'https://example.com',inputs:{service:'app-configuration-service'}}));
  for (const value of ['jjd_' + 'a1'.repeat(24), 'app-' + 'a1'.repeat(12), 'pat_' + 'abc123'.repeat(5)]) {
    assert.throws(() => parsePlatformAppConfig({platform:'dify',baseUrl:'https://example.com',inputs:{value}}));
  }
});

test('畸形或未完成的平台流也必须脱敏保留的回答和工具证据', () => {
  const secret = 'jjd_' + 'a1'.repeat(24);
  const result = parseDifySse(`data: ${JSON.stringify({event:'message',answer:secret})}\n\n`);
  assert.ok(result.error);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('Dify 后续只有 id 和 observation 时仍能补齐原调用', () => {
  const stream = [{event:'agent_thought',id:'same',position:1,tool:'current_time',tool_input:'{"current_time":{"zone":"UTC"}}'},
    {event:'agent_thought',id:'same',position:1,observation:'{"current_time":"12:00"}'}, {event:'message_end'}]
    .map(data => `data: ${JSON.stringify(data)}\n\n`).join('');
  const result = parseDifySse(stream);
  assert.equal(result.toolCalls.length,1);
  assert.equal(result.toolCalls[0].result,'12:00');
  assert.deepEqual(result.toolCalls[0].arguments,{zone:'UTC'});
});

test("Bearer 仅在后接令牌形态时视为凭据，普通术语不误报", async () => {
  const { containsCredential, safeValue } = await import("../src/modules/eval-targets/platform-adapters/stream.js");
  assert.equal(containsCredential("API 使用 Bearer authentication 方式"), false);
  assert.equal(containsCredential("Bearer token 是一种令牌"), false);
  assert.equal(containsCredential("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"), true);
  assert.equal(containsCredential("Authorization: Bearer 0123456789abcdef0123456789abcdef"), true);
  // 共享 redactString 对 Bearer 后续词的处理保持原状（不在本车道改公共脱敏）；这里只要求不判为凭据泄露。
  assert.equal(safeValue("Bearer 0123456789abcdef0123456789abcdef").includes("0123456789abcdef"), false);
});

test('本地诊断携带 Bearer，401/403 立即认证失败，不能回退成成功', async () => {
  const { createServer } = await import('node:http');
  for (const status of [401, 403]) {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization ?? '');
      res.statusCode = req.url?.includes('parameters') ? 200 : status;
      res.end('{}');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
      for (const platform of ['dify', 'coze'] as const) {
        const adapter = createPlatformAdapter(parsePlatformAppConfig({ platform, baseUrl, ...(platform === 'coze' ? { botId: 'bot' } : {}) }), 'wrong-key', { fetch });
        const result = await adapter.diagnose();
        assert.equal(result.ok, false);
        assert.match(result.detail, /认证失败/);
      }
      assert.deepEqual(seen, ['Bearer wrong-key', 'Bearer wrong-key']);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  }
});
