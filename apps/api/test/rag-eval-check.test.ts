import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildDifyPreset } from '../../../packages/shared/src/rag-presets.js';
import { checkRagTarget, checkRagJudge } from '../src/modules/rag-eval/check.js';
import { buildSecurityFixtures, findCanaryHits } from '../src/modules/rag-eval/security.js';
import { readEntries } from '../src/modules/rag-eval/target-client.js';

let server: http.Server;
let base = '';
let lastBody: any;
const backup = { allow: process.env.LSE_TARGET_EGRESS_ALLOWLIST, priv: process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE };
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      lastBody = body ? JSON.parse(body) : {};
      if (req.url === '/denied') { res.writeHead(401); return res.end('secret-body'); }
      if (req.url === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>登录</html>'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answer: '你好', metadata: { retriever_resources: [] } }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LSE_TARGET_EGRESS_ALLOWLIST = base;
  process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';
});
after(async () => {
  await new Promise<void>(r => server.close(() => r()));
  for (const [key, val] of [['LSE_TARGET_EGRESS_ALLOWLIST', backup.allow], ['LSE_TARGET_EGRESS_ALLOW_PRIVATE', backup.priv]]) {
    if (val === undefined) delete process.env[key!]; else process.env[key!] = val;
  }
});
const target = () => ({ ...buildDifyPreset('chat', base, 'fake-test-key'), targetType: 'AGENT_API', model: 'agent-api' });
const checks = [{ key: 'active', label: '对象已启用', ok: true, required: true, hint: '' }];

test('Dify 对话预设复用密钥字段、隔离会话并替换问题占位符', async () => {
  const t = target();
  assert.equal(t.apiKey, 'fake-test-key');
  assert.equal(t.ragOptions.citationIdField, 'document_name');
  assert.equal(JSON.stringify(t.accessConfig).includes('fake-test-key'), false);
  const result = await checkRagTarget(t, t.ragOptions, checks);
  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(lastBody.query, '你好');
  assert.equal(lastBody.response_mode, 'blocking');
  assert.equal(lastBody.conversation_id, undefined);
  assert.equal(result.checks.find(c => c.key === 'citations')?.status, 'unconfigured');
});
test('配置路径写错时不能因回答字段回退而通过', async () => {
  const t = target();
  t.accessConfig.responseTextPath = 'missing';
  const r = await checkRagTarget(t, t.ragOptions, checks);
  assert.equal(r.ok, false);
  assert.match(r.checks.find(c => c.key === 'answer')!.reason, /路径/);
});
test('401 与 HTML 返回中文原因且不回传原始内容或凭据', async () => {
  for (const [path, reason] of [['/denied', /密钥|认证/], ['/html', /HTML/]] as const) {
    const t = { ...target(), baseUrl: base + path };
    const r = await checkRagTarget(t, t.ragOptions, checks);
    assert.equal(r.ok, false);
    assert.match(r.checks.find(c => c.status === 'fail')!.reason, reason);
    assert.doesNotMatch(JSON.stringify(r), /fake-test-key|secret-body|<html>/);
  }
});
test('配置必需项缺失时不发请求，检索接口失败时不放行', async () => {
  const t = target();
  lastBody = null;
  const r = await checkRagTarget(t, t.ragOptions, [{ ...checks[0]!, ok: false, hint: '请启用对象' }]);
  assert.equal(r.ok, false);
  assert.equal(lastBody, null);
  const retrieval = { url: base + '/denied', method: 'POST' as const, resultsPath: 'hits', topK: 1 };
  const r2 = await checkRagTarget(t, { ...t.ragOptions, retrieval }, checks);
  assert.equal(r2.ok, false);
  assert.equal(r2.checks.find(c => c.key === 'retrieval')!.status, 'fail');
});
test('未配置判定模型如实不可用；探活最多八个令牌且不泄露网关错误', async () => {
  assert.equal((await checkRagJudge(null)).available, false);
  let max = 0;
  const r = await checkRagJudge({ config: { baseUrl: base, apiKey: 'secret', model: 'm' }, name: '测试', source: 'env' }, async (_cfg, _messages, opts) => {
    max = opts!.maxTokens!;
    return { status: 'ERROR', error: 'secret upstream message', httpStatus: 403 } as any;
  });
  assert.ok(max > 0 && max <= 8);
  assert.equal(r.available, false);
  assert.match(r.message!, /权限/);
  assert.doesNotMatch(JSON.stringify(r), /secret/);
});
test('Dify 工作流预设默认 text 输出，允许指定其他单输出字段', () => {
  const p = buildDifyPreset('workflow', base + '/v1/', 'key');
  assert.equal(p.baseUrl, base + '/v1/workflows/run');
  assert.equal(p.accessConfig.responseTextPath, 'data.outputs.text');
  assert.throws(() => buildDifyPreset('chat', 'file:///tmp/a', 'key'));
});
test('检索引用支持 Dify 数组通配路径并拒绝原型链', () => {
  const raw = { metadata: { retriever_resources: [{ content: '中文知识', document_id: 'd1' }] } };
  assert.deepEqual(readEntries(raw, 'metadata.retriever_resources[*].content'), [{ text: '中文知识', id: null }]);
  assert.equal(readEntries(raw, 'metadata.__proto__[*].content'), null);
  assert.equal(readEntries(raw, 'metadata.retriever_resources[*].missing'), null);
});
test('安全题至少八道并覆盖五种场景，每题有可执行标记规则', () => {
  const f = buildSecurityFixtures('eight');
  assert.ok(f.items.length >= 8);
  for (const scenario of ['retrieval_injection', 'cross_access', 'sensitive_leak', 'refusal_jailbreak', 'citation_forgery']) {
    assert.ok(f.items.some(i => i.metadata.scenario === scenario), scenario);
  }
  for (const i of f.items) {
    const markers = i.metadata.canaries as string[];
    assert.ok(markers.length > 0);
    assert.ok(findCanaryHits(markers.join(' '), markers).length > 0);
    assert.equal(findCanaryHits('我不能提供该内容', markers).length, 0);
  }
});

test('安全细分场景的判定说明和风险类别与实际规则一致', async () => {
  const mod = await import('../src/modules/rag-eval/security.js');
  assert.equal(typeof mod.evaluateSecurityAnswer, 'function');
  const f = buildSecurityFixtures('scenarios');
  for (const scenario of ['sensitive_leak', 'citation_forgery', 'refusal_jailbreak']) {
    const item = f.items.find(i => i.metadata.scenario === scenario)!;
    const result = mod.evaluateSecurityAnswer((item.metadata.canaries as string[])[0]!, item.metadata);
    assert.equal(result.failed, true);
    assert.ok(result.reason.length > 0);
    assert.equal(result.profile.riskCategory, scenario === 'sensitive_leak' ? 'data_exfiltration' : scenario === 'citation_forgery' ? 'misinformation_hallucination' : 'prompt_injection');
    assert.equal(mod.evaluateSecurityAnswer('我拒绝提供该内容。', item.metadata).failed, false);
  }
});
