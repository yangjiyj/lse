import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import type { LlmCallResult } from '@lse/shared';
import { buildTestPackage, zipTestPackage, reconstructText } from '../src/modules/rag-eval/test-package.js';
import { buildSecurityFixtures } from '../src/modules/rag-eval/security.js';
import { waitForIndexReady, probeHit } from '../src/modules/rag-eval/index-probe.js';
import { computeRagGroupMetrics } from '../src/modules/rag-eval/metrics.js';
import type { EvaluationTargetConfig } from '../src/modules/eval-targets/invoker.js';

const fx = buildSecurityFixtures('pkg-seed');
const set = { id: 'set-1', name: '测试集', seed: 'pkg-seed', poisonDocument: fx.poisonDocument, sentinelDocument: fx.sentinelDocument };
const docs = [
  {
    id: '11111111-2222-3333-4444-555555555555',
    filename: '差旅制度.md',
    sha256: 'shaA',
    chunks: [
      { seq: 0, content: '第一段内容，重叠部分', charStart: 0, charEnd: 10 },
      { seq: 1, content: '重叠部分第二段内容', charStart: 6, charEnd: 15 },
    ],
  },
];

test('reconstructText 按字符区间拼接，去掉切块重叠', () => {
  assert.equal(reconstructText(docs[0]!.chunks), '第一段内容，重叠部分第二段内容');
});

test('测试知识库包：manifest + documents/ + restricted/，每个文档带探针与哈希', () => {
  const pkg = buildTestPackage(set, docs, { includeSecurity: true });
  const files = unzipSync(zipTestPackage(pkg));
  const names = Object.keys(files).sort();
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.some((n) => n.startsWith('documents/lse-doc-111111112222__')));
  assert.ok(names.includes('documents/lse-rag-poison-test.md'));
  assert.ok(names.includes('restricted/lse-rag-sentinel-test.md'));
  const manifest = JSON.parse(strFromU8(files['manifest.json']!));
  assert.equal(manifest.format, 'lse-rag-test-package/v1');
  const corpus = manifest.documents.find((d: { role: string }) => d.role === 'corpus');
  assert.match(corpus.probe, /^LSE-PROBE-/);
  assert.equal(corpus.sourceSha256, 'shaA');
  assert.equal(corpus.content, undefined, 'manifest 不重复正文');
  const body = strFromU8(files[`documents/${corpus.filename}`]!);
  assert.ok(body.includes(corpus.probe));
  // 同一种子可复现
  assert.deepEqual(buildTestPackage(set, docs, { includeSecurity: true }).manifest, pkg.manifest);
});

function ans(content: string, raw: unknown = null): LlmCallResult {
  return { status: 'SUCCESS', content, finishReason: 'stop', model: 'm', usage: { promptTokens: null, completionTokens: null, totalTokens: null }, latencyMs: 1, httpStatus: 200, error: null, raw };
}

test('索引就绪探测：前两轮未命中，第三轮命中即就绪；超时返回未就绪', async () => {
  const doc = { manifestId: 'lse-doc-1', filename: 'a.md', probe: 'LSE-PROBE-ABC', fingerprint: '差旅报销须在出差结束后十五个工作日内提交' };
  let calls = 0;
  const sleeps: number[] = [];
  const ask = async () => {
    calls++;
    return calls >= 3 ? ans('差旅报销须在出差结束后十五个工作日内提交。') : ans('没有找到');
  };
  const r = await waitForIndexReady({} as EvaluationTargetConfig, { indexPollIntervalSec: 2, indexWaitTimeoutSec: 60 }, [doc], {
    ask: ask as never,
    sleep: async (ms) => void sleeps.push(ms),
  });
  assert.equal(r.ready, true);
  assert.equal(r.attempts, 3);
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.equal(r.docs[0]!.via, 'answer');

  let t = 0;
  const never = await waitForIndexReady({} as EvaluationTargetConfig, { indexPollIntervalSec: 5, indexWaitTimeoutSec: 12 }, [doc], {
    ask: (async () => ans('无')) as never,
    sleep: async (ms) => void (t += ms),
    now: () => t,
  });
  assert.equal(never.ready, false);
  assert.match(never.error!, /12 秒/);
  // 检索上下文中带探针也算命中
  assert.equal(probeHit(ans('x', { ctx: [{ content: '…LSE-PROBE-ABC…' }] }), { contextPath: 'ctx' }, doc), 'context');
});

test('computeRagGroupMetrics 分组：未评估项不进通过率并列出原因；检索 Hit@k/MRR', () => {
  const base = { status: 'SUCCESS', verdict: 'PASS', correctness: 1, faithfulness: null, refusalOk: null, citationAccuracy: null };
  const g = computeRagGroupMetrics([
    { ...base, itemType: 'FACT', retrievalEvaluated: true, retrievalRank: 1, notEvaluated: { faithfulness: '未评估：未配置 contextPath', citation: '未返回引用' } },
    { ...base, itemType: 'FACT', correctness: 0, verdict: 'FAIL', retrievalEvaluated: true, retrievalRank: 2 },
    { ...base, itemType: 'FACT', retrievalEvaluated: true, retrievalRank: null },
    { ...base, itemType: 'NO_ANSWER', correctness: null, verdict: 'UNKNOWN', needsReview: true },
    { itemType: 'CROSS_ACCESS', status: 'RESTRICTED', verdict: 'UNKNOWN', correctness: null, faithfulness: null, refusalOk: null, citationAccuracy: null, reason: '未评估：缺少受限库上传凭据' },
  ]);
  const correct = g.generation.find((m) => m.key === 'correctness')!;
  assert.equal(correct.samples, 3);
  assert.equal(correct.passRate, 2 / 3);
  const faith = g.generation.find((m) => m.key === 'faithfulness')!;
  assert.equal(faith.samples, 0);
  assert.equal(faith.passRate, null);
  assert.ok(faith.notEvaluatedReasons.some((r) => r.reason.includes('contextPath')));
  assert.equal(g.retrievalStats.samples, 3);
  assert.equal(g.retrievalStats.hitAtK, 2 / 3);
  assert.equal(g.retrievalStats.mrr, (1 + 0.5 + 0) / 3);
  const cross = g.security.find((m) => m.key === 'CROSS_ACCESS')!;
  assert.equal(cross.samples, 0);
  assert.equal(cross.notEvaluatedReasons[0]!.reason, '未评估：缺少受限库上传凭据');
});
