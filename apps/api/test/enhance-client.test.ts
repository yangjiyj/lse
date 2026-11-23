import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnhanceConfigFromEnv,
  createEnhanceLlmClient,
  isEnhanceConfigured,
} from '../src/modules/generator/enhance/llm-client.js';

// 测试调用会替换 fetch，但出站策略仍须看到显式授权的 loopback 目标。
const originalTargetAllowlist = process.env.LSE_TARGET_EGRESS_ALLOWLIST;
const originalAllowPrivate = process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
process.env.LSE_TARGET_EGRESS_ALLOWLIST = 'http://127.0.0.1:18081';
process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';

after(() => {
  if (originalTargetAllowlist === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  else process.env.LSE_TARGET_EGRESS_ALLOWLIST = originalTargetAllowlist;
  if (originalAllowPrivate === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
  else process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = originalAllowPrivate;
});

function env(overrides: Record<string, string | undefined>) {
  return { ENHANCE_LLM_ENABLED: 'true', ...overrides } as NodeJS.ProcessEnv;
}

test('缺少增强 LLM 配置时视为未配置', () => {
  const cfg = buildEnhanceConfigFromEnv(
    env({ ENHANCE_LLM_BASE_URL: '', ENHANCE_LLM_API_KEY: '', ENHANCE_LLM_MODEL: '' }),
  );
  assert.equal(isEnhanceConfigured(cfg), false);
});

test('增强客户端拒绝 ModelTarget 形状对象', () => {
  let err: unknown;
  try {
    createEnhanceLlmClient({
      provider: 'openai-compatible',
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      isGlobal: true,
    } as any);
  } catch (e) {
    err = e;
  }
  assert.match(String(err), /ENHANCE_MODEL_TARGET_FORBIDDEN|增强模型不能复用评估对象/);
  assert.equal((err as { statusCode?: number }).statusCode, 400);
});

test('chat 使用 OpenAI 兼容请求且不泄露额外字段', async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"content":"增强题"}' }, finish_reason: 'stop' }],
        model: 'enhancer',
      }),
      { status: 200 },
    );
  }) as any;

  try {
    const client = createEnhanceLlmClient({
      baseUrl: 'http://127.0.0.1:18081/v1',
      apiKey: 'enhance-key',
      model: 'enhance-model',
      timeoutMs: 1000,
    });
    const res = await client.chat([{ role: 'user', content: 'hi' }]);

    assert.equal(res.status, 'SUCCESS');
    assert.equal(calls[0]!.url, 'http://127.0.0.1:18081/v1/chat/completions');
    assert.equal(calls[0]!.headers.authorization, 'Bearer enhance-key');
    assert.equal(calls[0]!.body.model, 'enhance-model');
    assert.equal(calls[0]!.body.provider, undefined);
    assert.equal(calls[0]!.body.isGlobal, undefined);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
