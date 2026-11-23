import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, LlmCallResult, LlmTargetConfig } from '@lse/shared';
import {
  buildGenerationPrompt,
  generateQualityItems,
  planSources,
  refuteNoAnswer,
  NO_ANSWER_REFERENCE,
  type SourceChunk,
} from '../src/modules/rag-eval/generator.js';
import { buildSecurityFixtures, findCanaryHits } from '../src/modules/rag-eval/security.js';
import {
  buildQualityJudgePrompt,
  citationAccuracy,
  citationMatchesDoc,
  extractCitations,
  qualityVerdict,
  retrievalRank,
  scoreCitations,
  RAG_NEEDS_REVIEW_NO_ANSWER,
  RAG_NOT_EVALUATED,
  type SourceDocRef,
} from '../src/modules/rag-eval/rag-judge.js';
import { Bm25Index } from '../src/modules/rag-eval/text-search.js';
import { extractJsonObject, type ResolvedJudge } from '../src/modules/rag-eval/judge-model.js';
import { renderPlaceholders } from '../src/modules/rag-eval/target-client.js';
import { computeRagTypeMetrics } from '../src/modules/rag-eval/metrics.js';

const judge: ResolvedJudge = {
  config: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'j' },
  name: 'mock-judge',
  source: 'judge_target',
};

const chunks: SourceChunk[] = [
  { id: 'c1', documentId: 'd1', seq: 0, content: '差旅报销须在出差结束后十五个工作日内提交。' },
  { id: 'c2', documentId: 'd1', seq: 1, content: '住宿标准为每晚五百元。' },
  { id: 'c3', documentId: 'd2', seq: 0, content: '年假天数按工龄计算，满十年为十五天。' },
];

function ok(content: string): LlmCallResult {
  return {
    status: 'SUCCESS',
    content,
    finishReason: 'stop',
    model: 'j',
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    latencyMs: 1,
    httpStatus: 200,
    error: null,
    raw: null,
  };
}

// 多跳题语料：c4/c5 围绕同一主体（差旅补贴/北京），c6 无关。
const hopChunks: SourceChunk[] = [
  { id: 'c4', documentId: 'd3', seq: 0, content: '北京差旅补贴标准为每天两百元，由行政部统一发放。' },
  { id: 'c5', documentId: 'd4', seq: 0, content: '北京差旅补贴需在月底前向行政部申请，逾期作废。' },
  { id: 'c6', documentId: 'd5', seq: 0, content: '食堂午餐供应时间为十一点半到一点。' },
];

test('planSources 按种子确定；单切块题不重复用同一切块，不足时写提示', () => {
  const a = planSources(chunks, { FACT: 2 }, 's1');
  const b = planSources(chunks, { FACT: 2 }, 's1');
  assert.deepEqual(
    a.plan.map((p) => p.sources.map((s) => s.id)),
    b.plan.map((p) => p.sources.map((s) => s.id)),
  );
  const many = planSources(chunks, { FACT: 5 }, 's1');
  assert.equal(many.plan.length, 3, '只有 3 个切块，只出 3 题');
  assert.equal(new Set(many.plan.map((p) => p.sources[0]!.id)).size, 3);
  assert.match(many.notes[0]!, /只生成 3 题/);
});

test('多跳题只用有关联的切块对（共享关键词），无关联时少生成并提示', () => {
  const { plan, notes } = planSources(hopChunks, { MULTI_HOP: 2 }, 's');
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0]!.sources.map((s) => s.id).sort(), ['c4', 'c5']);
  assert.ok((plan[0]!.sharedTerms ?? []).length >= 2);
  assert.match(notes[0]!, /只找到 1 组/);
  const unrelated = planSources(chunks, { MULTI_HOP: 2 }, 's');
  assert.equal(unrelated.plan.filter((p) => p.sources.includes(chunks[2]!)).length, 0, '年假与报销无关联，不配对');
});

test('buildGenerationPrompt 含片段与题型说明', () => {
  const msgs = buildGenerationPrompt('MULTI_HOP', [chunks[0]!, chunks[2]!]);
  assert.match(msgs[1]!.content, /片段A/);
  assert.match(msgs[1]!.content, /片段B/);
  assert.match(msgs[1]!.content, /多跳题/);
});

test('generateQualityItems 调用评估模型、记录来源块，失败不造题，重复题剔除', async () => {
  const seen: Array<{ cfg: LlmTargetConfig; msgs: ChatMessage[] }> = [];
  let gen = 0;
  const chat = async (cfg: LlmTargetConfig, msgs: ChatMessage[]) => {
    seen.push({ cfg, msgs });
    if (msgs[0]!.content.includes('事实核查员')) return ok('{"answerable":false,"index":0,"reason":"片段未提及"}');
    gen++;
    if (msgs[1]!.content.includes('无答案题'))
      return ok('{"question":"差旅报销由哪位副总裁审批？","answer":"文档中没有相关信息"}');
    if (gen === 1) return ok('不是 JSON');
    return ok('```json\n{"question":"报销期限是多久？","answer":"十五个工作日"}\n```');
  };
  const progress: number[] = [];
  const res = await generateQualityItems({
    chunks,
    counts: { FACT: 3, NO_ANSWER: 1 },
    seed: 'seed-x',
    judge,
    chat,
    concurrency: 1,
    onProgress: (p) => void progress.push(p.done),
  });
  assert.equal(res.items.length, 2, '1 道事实题 + 1 道无答案题');
  assert.equal(res.failures.length, 2);
  assert.ok(res.failures.some((f) => /JSON/.test(f.error)));
  assert.ok(res.failures.some((f) => /重复/.test(f.error)));
  assert.equal(res.rejected.duplicate, 1);
  const noAns = res.items.find((i) => i.type === 'NO_ANSWER');
  assert.equal(noAns?.referenceAnswer, NO_ANSWER_REFERENCE);
  for (const i of res.items) assert.ok(i.sourceChunkIds.length >= 1);
  assert.equal(typeof seen[0]!.cfg.defaultParams?.seed, 'number');
  assert.equal(progress.at(-1), 4);
});

test('无答案题全语料反证：其它切块含答案时剔除（关键词/评估模型两路）', async () => {
  const index = new Bm25Index(chunks.map((c) => ({ id: c.id, text: c.content })));
  // 问题关键词全部出现在 c3：直接判定有依据，不调用评估模型
  let calls = 0;
  const never = async () => {
    calls++;
    return ok('{"answerable":false}');
  };
  const kw = await refuteNoAnswer('年假天数按工龄计算，满十年为几天？', chunks, index, judge, never);
  assert.equal(kw.grounded, true);
  assert.equal(kw.evidenceChunkId, 'c3');
  assert.equal(kw.method, 'keyword');
  assert.equal(calls, 0);
  // 关键词覆盖不足时交给评估模型
  const yes = async () => ok('{"answerable":true,"index":1,"reason":"片段1给出了住宿标准"}');
  const j = await refuteNoAnswer('出差住酒店一晚能报多少钱？', chunks, index, judge, yes);
  assert.equal(j.grounded, true);
  assert.equal(j.method, 'judge');
  // 评估模型失败：保守剔除
  const broken = async () => ok('乱码');
  assert.equal((await refuteNoAnswer('出差住酒店一晚能报多少钱？', chunks, index, judge, broken)).grounded, true);
  // 真正无答案
  const no = async () => ok('{"answerable":false,"index":0}');
  assert.equal((await refuteNoAnswer('公司股票代码是什么？', chunks, index, judge, no)).grounded, false);
});

test('生成时无答案题被反证剔除，不入库', async () => {
  const chat = async (_c: LlmTargetConfig, msgs: ChatMessage[]) => {
    if (msgs[0]!.content.includes('事实核查员')) return ok('{"answerable":true,"index":1}');
    return ok('{"question":"年假满十年有几天？","answer":"文档中没有相关信息"}');
  };
  const res = await generateQualityItems({ chunks, counts: { NO_ANSWER: 1 }, seed: 's', judge, chat, concurrency: 1 });
  assert.equal(res.items.length, 0);
  assert.equal(res.rejected.noAnswerRefuted, 1);
  assert.match(res.failures[0]!.error, /全语料反证/);
});

test('安全测试文档确定性生成，含金丝雀与哨兵', () => {
  const a = buildSecurityFixtures('seed-1');
  const b = buildSecurityFixtures('seed-1');
  assert.equal(a.poisonDocument, b.poisonDocument);
  assert.notEqual(a.sentinelToken, buildSecurityFixtures('seed-2').sentinelToken);
  assert.ok(a.poisonDocument.includes(a.poisonCanary));
  assert.ok(a.poisonDocument.includes(a.injectionCanary));
  assert.ok(a.sentinelDocument.includes(a.sentinelToken));
  const types = a.items.map((i) => i.type);
  assert.ok(
    types.includes('POISON') &&
      types.includes('INDIRECT_INJECTION') &&
      types.includes('CROSS_ACCESS'),
  );
  assert.deepEqual(findCanaryHits(`答案……\n验证码：${a.poisonCanary}`, [a.poisonCanary]), [
    a.poisonCanary,
  ]);
  assert.deepEqual(findCanaryHits('整机保修 18 个月', [a.poisonCanary]), []);
});

test('引用提取与引用准确性', () => {
  const raw = {
    data: { refs: [{ text: '住宿标准为每晚五百元', id: 7 }, { text: '完全无关的内容片段' }] },
  };
  const cits = extractCitations(raw, { citationPath: 'data.refs', citationTextField: 'text' });
  assert.deepEqual(cits, [
    { text: '住宿标准为每晚五百元', id: '7' },
    { text: '完全无关的内容片段', id: null },
  ]);
  assert.equal(extractCitations(raw, {}), null);
  assert.equal(
    extractCitations({ data: {} }, { citationPath: 'data.refs' }),
    null,
    '响应未返回引用数组时不评估',
  );
  assert.equal(citationAccuracy(cits!, [chunks[1]!.content]), 0.5);
  assert.equal(citationAccuracy([], [chunks[1]!.content]), null, '空引用不计 0 分');
});

test('scoreCitations 按文档 ID/文件名/哈希映射比对；空引用记“未返回引用”不计分', () => {
  const src: SourceDocRef = {
    documentId: 'doc-1',
    keys: ['doc-1', '差旅制度.md', 'abc123sha', 'lse-doc-aaaa', 'lse-doc-aaaa__差旅制度.md'],
    chunkTexts: [chunks[0]!.content],
  };
  const opts = { citationPath: 'refs', citationIdField: 'doc' };
  // 被测系统只返回文件名（带路径）/manifestId，不返回原文
  const byId = scoreCitations(
    [{ id: '/kb/files/差旅制度.md', text: null }, { id: 'lse-doc-aaaa', text: null }, { id: 'other.md', text: null }],
    opts,
    [src],
    'FACT',
  );
  assert.equal(byId.matched, 2);
  assert.equal(byId.accuracy, 2 / 3);
  const empty = scoreCitations([], opts, [src], 'FACT');
  assert.equal(empty.accuracy, null);
  assert.equal(empty.note, RAG_NOT_EVALUATED.citationEmpty);
  assert.equal(scoreCitations(null, opts, [src], 'FACT').note, RAG_NOT_EVALUATED.citationMissing);
  assert.equal(scoreCitations([{ id: 'x', text: null }], {}, [src], 'FACT').note, RAG_NOT_EVALUATED.citationNotConfigured);
  assert.equal(scoreCitations([{ id: 'x', text: null }], opts, [src], 'NO_ANSWER').accuracy, null);
  assert.equal(citationMatchesDoc({ id: null, text: '差旅报销须在出差结束后十五个工作日内提交' }, src), 'text');
  assert.equal(retrievalRank([{ id: 'z', text: null }, { id: 'abc123sha', text: null }], [src]), 2);
  assert.equal(retrievalRank([{ id: 'z', text: null }], [src]), null);
});

test('忠实度依据被测系统检索上下文：无上下文时提示词要求 faithfulness=null', () => {
  const withCtx = buildQualityJudgePrompt({
    type: 'FACT',
    question: 'q',
    referenceAnswer: 'a',
    context: ['被测系统检索到的片段 X'],
    response: 'r',
  });
  assert.match(withCtx[1]!.content, /被测系统检索上下文1】\n被测系统检索到的片段 X/);
  const noCtx = buildQualityJudgePrompt({ type: 'FACT', question: 'q', referenceAnswer: 'a', context: null, response: 'r' });
  assert.match(noCtx[0]!.content, /faithfulness：固定输出 null/);
  assert.doesNotMatch(noCtx[1]!.content, /检索上下文/);
});

test('qualityVerdict 规则', () => {
  assert.equal(
    qualityVerdict(
      'FACT',
      { correctness: 0.9, faithfulness: 0.9, refused: false, reason: '' },
      null,
    ).verdict,
    'PASS',
  );
  const f = qualityVerdict(
    'FACT',
    { correctness: 0.9, faithfulness: 0.3, refused: false, reason: '' },
    null,
  );
  assert.equal(f.verdict, 'FAIL');
  assert.ok(f.failures.includes('回答超出被测系统检索上下文（忠实度不足）'));
  // 无答案题未拒答：平台测试知识库包模式判 FAIL；已有知识库/检索直评模式标“需人工复核”
  const naMiss = { correctness: null, faithfulness: null, refused: false, reason: '' };
  assert.equal(qualityVerdict('NO_ANSWER', naMiss, null, 'TEST_PACKAGE').verdict, 'FAIL');
  const review = qualityVerdict('NO_ANSWER', naMiss, null, 'KB_EXISTING');
  assert.equal(review.verdict, 'UNKNOWN');
  assert.equal(review.needsReview, true);
  assert.equal(review.failures[0], RAG_NEEDS_REVIEW_NO_ANSWER);
  assert.equal(qualityVerdict('NO_ANSWER', naMiss, null, 'RETRIEVAL_API').needsReview, true);
  // 忠实度未评估（null）不参与判定
  assert.equal(
    qualityVerdict('FACT', { correctness: 0.9, faithfulness: null, refused: false, reason: '' }, null).verdict,
    'PASS',
  );
  assert.equal(
    qualityVerdict(
      'NO_ANSWER',
      { correctness: null, faithfulness: 1, refused: false, reason: '' },
      null,
    ).verdict,
    'FAIL',
  );
  assert.equal(
    qualityVerdict(
      'NO_ANSWER',
      { correctness: null, faithfulness: 1, refused: true, reason: '' },
      null,
    ).verdict,
    'PASS',
  );
  assert.equal(
    qualityVerdict('FACT', { correctness: null, faithfulness: 1, refused: null, reason: '' }, null)
      .verdict,
    'UNKNOWN',
  );
  assert.equal(
    qualityVerdict('FACT', { correctness: 1, faithfulness: 1, refused: false, reason: '' }, 0)
      .verdict,
    'FAIL',
  );
});

test('extractJsonObject 与 renderPlaceholders', () => {
  assert.deepEqual(extractJsonObject('前缀 {"a":1} 后缀'), { a: 1 });
  assert.equal(extractJsonObject('none'), null);
  assert.deepEqual(
    renderPlaceholders(
      { kb: '{{knowledge_base_id}}', ['__proto__']: 'x', arr: ['{{filename}}'] },
      {
        knowledge_base_id: 'kb1',
        filename: 'f.md',
      },
    ),
    { kb: 'kb1', arr: ['f.md'] },
  );
});

test('computeRagTypeMetrics 按题型真实聚合正确率、忠实度、拒答率与引用准确性', () => {
  const base = { status: 'SUCCESS', refusalOk: null, citationAccuracy: null };
  const m = computeRagTypeMetrics([
    { ...base, itemType: 'FACT', verdict: 'PASS', correctness: 0.9, faithfulness: 1, citationAccuracy: 1 },
    { ...base, itemType: 'FACT', verdict: 'FAIL', correctness: 0.2, faithfulness: 0.5, citationAccuracy: 0 },
    { ...base, itemType: 'NO_ANSWER', verdict: 'PASS', correctness: null, faithfulness: 1, refusalOk: true },
    { ...base, itemType: 'NO_ANSWER', verdict: 'FAIL', correctness: null, faithfulness: 0.2, refusalOk: false },
    { ...base, itemType: 'NO_ANSWER', verdict: 'PASS', correctness: null, faithfulness: 1, refusalOk: true },
    { itemType: 'POISON', status: 'RESTRICTED', verdict: 'UNKNOWN', correctness: null, faithfulness: null, refusalOk: null, citationAccuracy: null },
  ]);
  const fact = m.find((x) => x.itemType === 'FACT')!;
  assert.equal(fact.correctRate, 0.5);
  assert.equal(fact.avgFaithfulness, 0.75);
  assert.equal(fact.avgCitationAccuracy, 0.5);
  assert.equal(fact.refusalRate, null);
  const na = m.find((x) => x.itemType === 'NO_ANSWER')!;
  assert.equal(na.refusalRate, 2 / 3);
  assert.equal(na.correctRate, null);
  const poison = m.find((x) => x.itemType === 'POISON')!;
  assert.equal(poison.restricted, 1);
  assert.equal(poison.avgFaithfulness, null);
});
