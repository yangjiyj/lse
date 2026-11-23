import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CurlParseError,
  detectPromptField,
  detectResponseTextPaths,
  maskSecret,
  parseCurlCommand,
  readJsonPath,
  tokenizeShell,
} from '@lse/shared';

test('tokenizeShell：反斜杠续行、单双引号、$引号与转义', () => {
  const tokens = tokenizeShell(
    'curl -X POST \\\n  \'https://a.example.com/x\' \\\n  -H "X-A: \\"q\\"" \\\n  --data-raw $\'{"a":"l1\\\\nl2"}\'',
  );
  assert.deepEqual(tokens, [
    'curl',
    '-X',
    'POST',
    'https://a.example.com/x',
    '-H',
    'X-A: "q"',
    '--data-raw',
    '{"a":"l1\\nl2"}',
  ]);
});

test('tokenizeShell：引号未闭合时报中文错误', () => {
  assert.throws(() => tokenizeShell("curl 'https://a"), CurlParseError);
  assert.throws(() => tokenizeShell('curl "https://a'), /双引号未闭合/);
});

test('OpenAI 兼容 curl：识别 URL、方法、Bearer 认证、messages 提示词与模型建议', () => {
  const r = parseCurlCommand(`curl https://api.example.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-abcdef1234567890" \\
  -d '{"model":"qwen-max","messages":[{"role":"system","content":"你是助手"},{"role":"user","content":"你好"}],"stream":false}'`);
  assert.equal(r.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(r.method, 'POST');
  assert.equal(r.auth.type, 'bearer');
  assert.equal(r.auth.value, 'sk-abcdef1234567890');
  assert.equal(r.auth.maskedValue, 'sk-a****7890');
  assert.equal(r.headers.Authorization, undefined, '认证头不能残留在普通请求头中');
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.equal(r.promptPath, 'messages[1].content');
  assert.equal(r.promptSample, '你好');
  assert.deepEqual(r.requestTemplate, {
    model: 'qwen-max',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '{{prompt}}' },
    ],
    stream: false,
  });
  assert.deepEqual(r.openAiCompatible, {
    baseUrl: 'https://api.example.com/v1',
    model: 'qwen-max',
  });
  assert.equal(r.streamRequested, false);
});

test('Dify 风格 curl：识别 query 字段、会话字段与流式请求', () => {
  const r = parseCurlCommand(`curl -X POST 'https://dify.example.com/v1/chat-messages' \\
--header 'Authorization: Bearer app-XYZ123456789' \\
--header 'Content-Type: application/json' \\
--data-raw '{"inputs":{},"query":"请介绍管网调度","response_mode":"streaming","conversation_id":"","user":"abc-123"}'`);
  assert.equal(r.promptPath, 'query');
  assert.equal(r.promptSample, '请介绍管网调度');
  assert.equal(r.streamRequested, true);
  assert.deepEqual(r.sessionFieldPaths, ['conversation_id']);
  assert.equal(r.openAiCompatible, null);
  assert.equal((r.requestTemplate as Record<string, unknown>).query, '{{prompt}}');
});

test('api-key / x-api-key 认证头进入认证配置并保留头名', () => {
  const a = parseCurlCommand(
    `curl https://a.example.com/chat -H 'api-key: abcd1234efgh5678' -d '{"prompt":"hi"}'`,
  );
  assert.equal(a.auth.type, 'api_key');
  assert.equal(a.auth.headerName, 'api-key');
  assert.equal(a.auth.value, 'abcd1234efgh5678');
  assert.equal(a.headers['api-key'], undefined);
  assert.equal(a.promptPath, 'prompt');

  const b = parseCurlCommand(
    `curl https://a.example.com/chat -H 'X-API-Key: k-1' --data '{"input":"hi"}'`,
  );
  assert.equal(b.auth.type, 'api_key');
  assert.equal(b.auth.headerName, 'X-API-Key');
  assert.equal(b.auth.maskedValue, '****');
  assert.equal(b.promptPath, 'input');
});

test('-u 用户名密码转为 Basic 认证头', () => {
  const r = parseCurlCommand(
    `curl -u alice:secret https://a.example.com/ask -d '{"question":"q"}'`,
  );
  assert.equal(r.auth.type, 'api_key');
  assert.equal(r.auth.headerName, 'Authorization');
  assert.equal(r.auth.value, `Basic ${Buffer.from('alice:secret').toString('base64')}`);
  assert.equal(r.promptPath, 'question');
  const zh = parseCurlCommand('curl -u 张三:p@ss https://a.example.com/ask');
  assert.equal(zh.auth.value, `Basic ${Buffer.from('张三:p@ss').toString('base64')}`);
});

test('--json、--url、--request=、-XPOST 连写形式', () => {
  const r = parseCurlCommand(
    `curl --request=PUT --url https://a.example.com/run --json '{"data":{"input":"x"}}'`,
  );
  assert.equal(r.method, 'PUT');
  assert.equal(r.url, 'https://a.example.com/run');
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.equal(r.promptPath, 'data.input');

  const c = parseCurlCommand(`curl -XPOST -H'X-A: 1' https://a.example.com/run`);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['X-A'], '1');
});

test('无请求体默认 GET 并提示；多个 -d 以 & 拼接；忽略 -s -k --compressed -m', () => {
  const g = parseCurlCommand('curl -s -k --compressed -m 30 https://a.example.com/health');
  assert.equal(g.method, 'GET');
  assert.equal(g.rawBody, null);
  assert.ok(g.warnings.some((w) => w.includes('没有请求体')));

  const f = parseCurlCommand(`curl https://a.example.com/f -d a=1 -d b=2`);
  assert.equal(f.rawBody, 'a=1&b=2');
  assert.equal(f.bodyIsJson, false);
  assert.ok(f.warnings.some((w) => w.includes('不是 JSON')));
});

test('多模态 content 数组中的 text 片段识别为提示词', () => {
  const r = parseCurlCommand(
    `curl https://a.example.com/v1/chat/completions -d '{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"看图"}]}]}'`,
  );
  assert.equal(r.promptPath, 'messages[0].content[0].text');
});

test('未识别提示词字段时给出提示且模板保持原样', () => {
  const r = parseCurlCommand(`curl https://a.example.com/x -d '{"foo":"bar"}'`);
  assert.equal(r.promptPath, null);
  assert.deepEqual(r.requestTemplate, { foo: 'bar' });
  assert.ok(r.warnings.some((w) => w.includes('{{prompt}}')));
});

test('拒绝非 http(s) URL、缺少 URL、空输入与本地文件请求体', () => {
  assert.throws(() => parseCurlCommand('curl file:///etc/passwd'), /仅支持 http 或 https/);
  assert.throws(() => parseCurlCommand('curl -X POST'), /未识别到请求 URL/);
  assert.throws(() => parseCurlCommand('   '), /请粘贴/);
  assert.throws(() => parseCurlCommand('curl -H'), /缺少取值/);
  const r = parseCurlCommand('curl https://a.example.com/x -d @body.json');
  assert.equal(r.rawBody, null);
  assert.ok(r.warnings.some((w) => w.includes('本地文件')));
});

test('Cookie 与多个认证头给出提示；Host/Content-Length 被丢弃', () => {
  const r = parseCurlCommand(
    `curl https://a.example.com/x -H 'Authorization: Bearer t1234567890' -H 'x-api-key: k2' -H 'Cookie: sid=1' -H 'Host: evil' -H 'Content-Length: 3' -d '{"query":"q"}'`,
  );
  assert.equal(r.auth.type, 'bearer');
  assert.equal(r.headers['x-api-key'], 'k2');
  assert.equal(r.headers.Host, undefined);
  assert.equal(r.headers['Content-Length'], undefined);
  assert.ok(r.warnings.some((w) => w.includes('Cookie')));
  assert.ok(r.warnings.some((w) => w.includes('多个认证')));
});

test('detectPromptField：优先 messages 最后一条 user；嵌套 inputs 对象', () => {
  assert.deepEqual(
    detectPromptField({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    }),
    { path: 'messages[2].content', value: 'c' },
  );
  assert.deepEqual(detectPromptField({ payload: { question: 'q' } }), {
    path: 'payload.question',
    value: 'q',
  });
  assert.equal(detectPromptField('x'), null);
});

test('readJsonPath：数组下标、负下标、拒绝原型链', () => {
  const json = { choices: [{ message: { content: 'hi' } }], list: [1, 2, 3] };
  assert.equal(readJsonPath(json, 'choices[0].message.content'), 'hi');
  assert.equal(readJsonPath(json, 'list[-1]'), 3);
  assert.equal(readJsonPath(json, 'choices.0.message.content'), 'hi');
  assert.equal(readJsonPath(json, '__proto__.toString'), undefined);
  assert.equal(readJsonPath(json, 'missing.x'), undefined);
});

test('detectResponseTextPaths：已知路径优先，其次按字符串长度推断，跳过 id/status 等字段', () => {
  assert.deepEqual(
    detectResponseTextPaths({ choices: [{ message: { role: 'assistant', content: '回答' } }] }),
    ['choices[0].message.content'],
  );
  assert.deepEqual(detectResponseTextPaths({ data: { answer: '好的' }, answer: '' }), [
    'data.answer',
  ]);
  const paths = detectResponseTextPaths({
    task_id: 'abcdefghijklmnopqrstuvwxyz',
    payload: { reply_text: '这是一个较长的回答内容' },
  });
  assert.deepEqual(paths, ['payload.reply_text']);
});

test('maskSecret 不回显完整凭据', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('short'), '****');
  assert.equal(maskSecret('sk-1234567890abcd'), 'sk-1****abcd');
});
