import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskReport, type ReportInputData } from '../src/modules/reports/report-builder.js';
import { renderRagSection, toReportRagSection } from '../src/modules/reports/rag-section.js';

const m = (label: string, over: Record<string, unknown> = {}) => ({
  key: label,
  label,
  applicable: 2,
  samples: 2,
  passed: 1,
  passRate: 0.5,
  average: 0.5,
  notEvaluated: 0,
  notEvaluatedReasons: [],
  ...over,
});

const ragRun = {
  alignmentMode: 'KB_EXISTING',
  alignmentConfirmedByName: 'admin',
  packageImported: false,
  testSet: { name: '制度测试集' },
  summary: {
    alignmentModeLabel: '已有知识库',
    groups: {
      generation: [
        m('正确性'),
        m('忠实度', { samples: 0, passRate: null, average: null, notEvaluated: 2, notEvaluatedReasons: [{ reason: '未评估：被测对象未配置检索上下文路径', count: 2 }] }),
        m('无答案拒答', { applicable: 1, samples: 1, passRate: 0, extra: { needsReview: 1 } }),
      ],
      retrieval: [m('命中率 Hit@k', { applicable: 0, samples: 0 }), m('MRR', { average: 0.75 })],
      security: [m('文档投毒', { applicable: 1, samples: 1, passRate: 0 })],
    },
  },
  cleanup: { ok: false, reason: '未配置删除接口', residual: [{ filename: 'lse-poison.md', knowledgeBaseId: 'kb-test' }] },
};

test('RAG 章节：分组指标、未评估原因、需人工复核、MRR 用均值、清理残留', () => {
  const md = renderRagSection([toReportRagSection(ragRun)]).join('\n');
  assert.match(md, /### RAG 专项评估/);
  assert.match(md, /知识对齐模式：已有知识库；对齐确认人：admin/);
  assert.match(md, /#### 生成质量[\s\S]*#### 检索质量[\s\S]*#### 安全项/);
  assert.match(md, /\| 忠实度 \| 未评估（被测对象未配置检索上下文路径） \| 0\/2 \|/);
  assert.match(md, /\| 无答案拒答 \| 0\.0% \| 1\/1；需人工复核 1 \|/);
  assert.match(md, /\| 命中率 Hit@k \| 不适用（测试集不含该类题目） \|/);
  assert.match(md, /\| MRR \| 0\.750 \|/);
  assert.match(md, /残留：lse-poison\.md（知识库 kb-test）/);
  assert.deepEqual(renderRagSection([]), []);
});

test('buildTaskReport：有 RAG 运行时在引擎执行情况后输出 RAG 章节，无则不输出', () => {
  const generatedAt = new Date('2026-09-29T01:00:00Z');
  const base = {
    task: {
      id: 't', name: 'RAG 任务', description: null, status: 'COMPLETED', concurrency: 1,
      engines: ['rag-eval'], dimensions: ['rag_quality', 'rag_security'], totalQuestions: 4, processedQuestions: 4,
      passedCount: 2, failedCount: 2, errorCount: 0, createdAt: generatedAt, startedAt: generatedAt, finishedAt: generatedAt,
      modelTarget: { name: '客服助手', provider: 'custom', model: 'agent' }, questionSets: [],
    },
    generatedAt, verdictCounts: { PASS: 2, FAIL: 2 }, engineRuns: [], wrongAnswers: [], findings: [], results: [],
  } as unknown as ReportInputData;
  const without = buildTaskReport(base).content;
  assert.doesNotMatch(without, /### RAG 专项评估/);
  const withRag = buildTaskReport({ ...base, rag: [toReportRagSection(ragRun)] }).content;
  const i = withRag.indexOf('## 三、引擎执行情况');
  const j = withRag.indexOf('### RAG 专项评估');
  const k = withRag.indexOf('## 四、风险项明细');
  assert.ok(i >= 0 && j > i && k > j, 'RAG 章节位于引擎执行情况与风险项明细之间');
});
