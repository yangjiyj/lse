import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_DETAIL_BUDGET_MS,
  DEFAULT_DETAIL_TIMEOUT_MS,
  probeEndpoint,
  probeTarget,
  classifyOpenAiModels,
} from '../src/modules/asset-discovery/probe.js';

const seen: Array<{ method: string; url: string; auth: string | undefined }> = [];
let ollama!: http.Server;
let vllm!: http.Server;
let redirector!: http.Server;
let big!: http.Server;
let ports = { ollama: 0, vllm: 0, redirector: 0, big: 0 };

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

function json(res: http.ServerResponse, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

before(async () => {
  ollama = http.createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    if (req.url === '/api/tags')
      return json(res, { models: [{ name: 'qwen2.5:7b' }, { name: 'llama3:8b' }] });
    res.writeHead(404).end();
  });
  vllm = http.createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    if (req.url === '/v1/models') {
      return json(res, {
        object: 'list',
        data: [{ id: 'Qwen/Qwen2.5-7B', object: 'model', owned_by: 'vllm', max_model_len: 8192 }],
      });
    }
    res.writeHead(404).end();
  });
  redirector = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://example.invalid/api/tags' }).end();
  });
  big = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"models":[' + '"x",'.repeat(200_000) + '"y"]}');
  });
  ports = {
    ollama: await listen(ollama),
    vllm: await listen(vllm),
    redirector: await listen(redirector),
    big: await listen(big),
  };
});

after(async () => {
  await Promise.all(
    [ollama, vllm, redirector, big].map((s) => new Promise((r) => s.close(() => r(null)))),
  );
});

test('识别 Ollama：/api/tags 返回模型清单；除 /api/show 查询外只发 GET，均不带凭据', async () => {
  const hit = await probeEndpoint('127.0.0.1', ports.ollama, { timeoutMs: 2000 });
  assert.ok(hit);
  assert.equal(hit.serviceType, 'OLLAMA');
  assert.deepEqual(hit.models, ['qwen2.5:7b', 'llama3:8b']);
  assert.equal(hit.baseUrl, `http://127.0.0.1:${ports.ollama}/v1`);
  assert.ok(
    seen.every(
      (r) => (r.method === 'GET' || (r.method === 'POST' && r.url === '/api/show')) && !r.auth,
    ),
  );
});

test('识别 vLLM：/v1/models owned_by=vllm', async () => {
  const hit = await probeEndpoint('127.0.0.1', ports.vllm, { timeoutMs: 2000 });
  assert.ok(hit);
  assert.equal(hit.serviceType, 'VLLM');
  assert.deepEqual(hit.models, ['Qwen/Qwen2.5-7B']);
});

test('不确定的 /v1/models 响应标为 OpenAI 兼容', () => {
  assert.equal(classifyOpenAiModels([{ id: 'm', owned_by: 'someone' }], {}), 'OPENAI_COMPATIBLE');
  assert.equal(classifyOpenAiModels([{ id: 'm', owned_by: 'xinference' }], {}), 'XINFERENCE');
});

test('不跟随重定向，响应体超上限时截断不识别', async () => {
  assert.equal(await probeEndpoint('127.0.0.1', ports.redirector, { timeoutMs: 2000 }), null);
  assert.equal(await probeEndpoint('127.0.0.1', ports.big, { timeoutMs: 2000 }), null);
});

test('识别 TGI /info 与 Triton /v2', async () => {
  const s = http.createServer((req, res) => {
    if (req.url === '/info')
      return json(res, { model_id: 'bigscience/bloom-560m', max_total_tokens: 2048 });
    res.writeHead(404).end();
  });
  const t = http.createServer((req, res) => {
    if (req.url === '/v2')
      return json(res, { name: 'triton', version: '2.40.0', extensions: ['classification'] });
    if (req.url === '/v2/models/stats')
      return json(res, { model_stats: [{ name: 'ensemble_llm' }, { name: 'ensemble_llm' }] });
    res.writeHead(404).end();
  });
  const [ps, pt] = [await listen(s), await listen(t)];
  const tgi = await probeEndpoint('127.0.0.1', ps, { timeoutMs: 2000 });
  const triton = await probeEndpoint('127.0.0.1', pt, { timeoutMs: 2000 });
  await Promise.all([s, t].map((x) => new Promise((r) => x.close(() => r(null)))));
  assert.equal(tgi?.serviceType, 'TGI');
  assert.deepEqual(tgi?.models, ['bigscience/bloom-560m']);
  assert.equal(triton?.serviceType, 'TRITON');
  assert.deepEqual(triton?.models, ['ensemble_llm']);
});

test('端口未监听时返回 null 且不抛错', async () => {
  const s = http.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(() => r(null)));
  assert.equal(await probeEndpoint('127.0.0.1', port, { timeoutMs: 1000 }), null);
});

test('主机名解析到链路本地地址时拒绝连接', async () => {
  const hit = await probeEndpoint('meta.test', 80, {
    timeoutMs: 1000,
    lookup: async () => '169.254.169.254',
  });
  assert.equal(hit, null);
});

function listenTls(server: https.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'asset-disc-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=llm.test',
        '-addext',
        'subjectAltName=DNS:llm.test,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('URL 目标：https + 路径前缀，按 <前缀>/models 识别 OpenAI 兼容接口', async () => {
  const urls: string[] = [];
  const hosts: string[] = [];
  const s = https.createServer(selfSigned(), (req, res) => {
    urls.push(req.url!);
    hosts.push(req.headers.host ?? '');
    if (req.url === '/v1/models')
      return json(res, { object: 'list', data: [{ id: 'gpt-x', owned_by: 'acme' }] });
    res.writeHead(404).end();
  });
  const port = await listenTls(s);
  try {
    const hit = await probeTarget(
      { scheme: 'https', host: 'llm.test', port, basePath: '/v1' },
      { timeoutMs: 2000, lookup: async () => '127.0.0.1' },
    );
    assert.ok(hit);
    assert.equal(hit.serviceType, 'OPENAI_COMPATIBLE');
    assert.deepEqual(hit.models, ['gpt-x']);
    assert.equal(hit.baseUrl, `https://llm.test:${port}/v1`);
    assert.ok(urls.includes('/v1/models'));
    assert.ok(!urls.includes('/v1/v1/models'));
    assert.ok(hosts.every((h) => h === `llm.test:${port}`));
  } finally {
    await new Promise((r) => s.close(() => r(null)));
  }
});

test('URL 目标：前缀不以版本号结尾时先试 <前缀>/v1/models，再试 <前缀>/models', async () => {
  const urls: string[] = [];
  const s = http.createServer((req, res) => {
    urls.push(req.url!);
    if (req.url === '/gw/openai/models')
      return json(res, { object: 'list', data: [{ id: 'm1', owned_by: 'vllm' }] });
    res.writeHead(404).end();
  });
  const port = await listen(s);
  try {
    const hit = await probeTarget(
      { scheme: 'http', host: '127.0.0.1', port, basePath: '/gw/openai' },
      { timeoutMs: 2000 },
    );
    assert.equal(hit?.serviceType, 'VLLM');
    assert.equal(hit?.baseUrl, `http://127.0.0.1:${port}/gw/openai`);
    assert.ok(urls.includes('/gw/openai/v1/models'));
    assert.ok(urls.indexOf('/gw/openai/v1/models') < urls.indexOf('/gw/openai/models'));
    assert.ok(urls.includes('/gw/openai/api/tags'));
  } finally {
    await new Promise((r) => s.close(() => r(null)));
  }
});

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

test('模型配置：Ollama 取 /api/tags 的 details 与 /api/show 的 *.context_length，单个模型失败不影响其他', async () => {
  const s = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      return json(res, {
        models: [
          {
            name: 'qwen2.5:7b',
            details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
          },
          {
            name: 'llama3:8b',
            details: { family: 'llama', parameter_size: '8.0B', quantization_level: 'Q4_0' },
          },
          { name: 'slow:1b', details: { family: 'gemma' } },
        ],
      });
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      const { model } = JSON.parse(await readBody(req)) as { model: string };
      if (model === 'qwen2.5:7b') {
        return json(res, {
          details: { family: 'qwen2' },
          model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 },
        });
      }
      if (model === 'slow:1b') return; // 不响应，靠单请求超时收尾
      res.writeHead(500).end();
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(s);
  try {
    const started = Date.now();
    const hit = await probeEndpoint('127.0.0.1', port, { timeoutMs: 2000, detailTimeoutMs: 300 });
    assert.ok(Date.now() - started < 1800, '详情请求单独超时');
    assert.equal(hit?.serviceType, 'OLLAMA');
    assert.deepEqual(hit?.modelDetails, [
      {
        name: 'qwen2.5:7b',
        family: 'qwen2',
        parameterSize: '7.6B',
        quantization: 'Q4_K_M',
        contextLength: 32768,
      },
      { name: 'llama3:8b', family: 'llama', parameterSize: '8.0B', quantization: 'Q4_0' },
      { name: 'slow:1b', family: 'gemma' },
    ]);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(() => r(null)));
  }
});

test('模型配置：Ollama 详情单次超时 5 秒、单个端点总共最多 15 秒，超出即停，已拿到的保留', async () => {
  assert.equal(DEFAULT_DETAIL_TIMEOUT_MS, 5000);
  assert.equal(DEFAULT_DETAIL_BUDGET_MS, 15000);
  const bodies: Array<Record<string, unknown>> = [];
  const names = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  const s = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      return json(res, { models: names.map((name) => ({ name, details: { family: 'qwen2' } })) });
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      bodies.push(body);
      if (body.model === 'm1') return json(res, { model_info: { 'qwen2.context_length': 4096 } });
      return; // 其余都不响应，靠超时收尾
    }
    res.writeHead(404).end();
  });
  const port = await listen(s);
  try {
    const started = Date.now();
    const hit = await probeEndpoint('127.0.0.1', port, {
      timeoutMs: 2000,
      detailTimeoutMs: 300,
      detailBudgetMs: 500,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `详情总时长受上限约束（不设上限要 1500ms 以上），实际 ${elapsed}ms`);
    assert.equal(bodies.length, 3, 'm1 立即返回，m2 超时 300ms，m3 只剩约 200ms，之后不再请求');
    assert.deepEqual(
      bodies[0],
      { model: 'm1', name: 'm1' },
      '请求体同时带 model 与 name，兼容旧版 Ollama',
    );
    assert.equal(hit?.modelDetails.length, 6, '查不到详情的模型仍保留 /api/tags 的字段');
    assert.deepEqual(hit?.modelDetails[0], { name: 'm1', family: 'qwen2', contextLength: 4096 });
    assert.deepEqual(hit?.modelDetails[5], { name: 'm6', family: 'qwen2' });
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(() => r(null)));
  }
});

test('模型配置：vLLM / OpenAI 兼容取 id 与 max_model_len', async () => {
  const hit = await probeEndpoint('127.0.0.1', ports.vllm, { timeoutMs: 2000 });
  assert.deepEqual(hit?.modelDetails, [{ name: 'Qwen/Qwen2.5-7B', contextLength: 8192 }]);
});

test('模型配置：TGI 取 model_id、max_input_tokens（或 max_input_length）；model_dtype 是精度，不算量化', async () => {
  const bodies: Array<Record<string, unknown>> = [
    {
      model_id: 'bigscience/bloom-560m',
      model_dtype: 'torch.float16',
      max_input_tokens: 4095,
      max_total_tokens: 4096,
    },
    { model_id: 'old/tgi', max_input_length: 1024, max_total_tokens: 2048 },
  ];
  const got = [];
  for (const body of bodies) {
    const s = http.createServer((req, res) => {
      if (req.url === '/info') return json(res, body);
      res.writeHead(404).end();
    });
    const port = await listen(s);
    got.push(await probeEndpoint('127.0.0.1', port, { timeoutMs: 2000 }));
    await new Promise((r) => s.close(() => r(null)));
  }
  assert.deepEqual(got[0]?.modelDetails, [
    { name: 'bigscience/bloom-560m', dtype: 'torch.float16', contextLength: 4095 },
  ]);
  assert.deepEqual(got[1]?.modelDetails, [{ name: 'old/tgi', contextLength: 1024 }]);
});

test('模型配置：Xinference 名称用 id（与模型列一致），model_name 记为系列，取 context_length，拿不到的字段留空', async () => {
  const s = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      return json(res, {
        object: 'list',
        data: [
          {
            id: 'my-qwen',
            object: 'model',
            owned_by: 'xinference',
            model_name: 'qwen2-instruct',
            context_length: 32768,
          },
          { id: 'bare', object: 'model', owned_by: 'xinference' },
        ],
      });
    }
    res.writeHead(404).end();
  });
  const port = await listen(s);
  try {
    const hit = await probeEndpoint('127.0.0.1', port, { timeoutMs: 2000 });
    assert.equal(hit?.serviceType, 'XINFERENCE');
    assert.deepEqual(hit?.models, ['my-qwen', 'bare']);
    assert.deepEqual(hit?.modelDetails, [
      { name: 'my-qwen', family: 'qwen2-instruct', contextLength: 32768 },
      { name: 'bare' },
    ]);
  } finally {
    await new Promise((r) => s.close(() => r(null)));
  }
});
