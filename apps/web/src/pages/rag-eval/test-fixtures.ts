import { vi } from 'vitest';

export const m = {
  status: vi.fn(),
  checkTarget: vi.fn().mockResolvedValue({ ok: true, httpStatus: 200, latencyMs: 1, checks: [] }),
  checkJudge: vi.fn().mockResolvedValue({ available: true, message: null }),
  targets: vi.fn(),
  corpora: vi.fn(),
  documents: vi.fn(),
  uploadDocument: vi.fn(),
  corpusChunks: vi.fn(),
  testSets: vi.fn(),
  testSet: vi.fn(),
  generateTestSet: vi.fn(),
  createEmptyTestSet: vi.fn(),
  cancelGeneration: vi.fn(),
  deleteTestSet: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  importItems: vi.fn(),
  exportItems: vi.fn(),
  downloadTestPackage: vi.fn(),
  runs: vi.fn(),
  run: vi.fn(),
  results: vi.fn(),
  createRun: vi.fn(),
  cancelRun: vi.fn(),
};

/** 评估对象接口（RAG 页新建/转换入口使用）。 */
export const mt = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

export const corpus = {
  id: 'c1',
  name: '制度库',
  description: null,
  createdAt: '2026-09-29T00:00:00.000Z',
  documentCount: 1,
  chunkCount: 3,
  testSetCount: 1,
};

export const testSet = {
  id: 's1',
  corpusId: 'c1',
  corpusName: '制度库',
  name: '制度测试集',
  seed: 'seed-1',
  promptVersion: 'rag-testgen/v2',
  judgeModelName: '评估模型A',
  generationStats: null,
  itemCount: 8,
  runCount: 1,
  createdAt: '2026-09-29T00:00:00.000Z',
  alignmentMode: 'KB_EXISTING',
  alignmentModeLabel: '已有知识库',
  generationStatus: 'READY',
  generationProgress: null,
  generationError: null,
};

export const checklist = [
  { key: 'type', label: '对象类型为智能体应用 API（自定义 HTTP）', ok: true, required: true, hint: '' },
  { key: 'contextPath', label: '检索上下文路径（contextPath）', ok: false, required: false, hint: '未配置时忠实度记“未评估”' },
];

export const ragTarget = {
  id: 't1',
  name: '客服知识库助手',
  targetType: 'AGENT_API',
  isActive: true,
  eligible: true,
  citationConfigured: false,
  contextConfigured: false,
  knowledgeUploadConfigured: false,
  knowledgeDeleteConfigured: false,
  retrievalConfigured: false,
  restrictedKnowledgeBaseConfigured: false,
  restrictedCredentialConfigured: false,
  checklist,
  ready: true,
};

export const run = {
  id: 'r1',
  taskId: 'k1',
  testSetId: 's1',
  testSetName: '制度测试集',
  modelTargetId: 't1',
  modelTargetName: '客服知识库助手',
  status: 'COMPLETED',
  taskStatus: 'COMPLETED',
  progress: 1,
  processed: 8,
  total: 8,
  summary: null,
  error: null,
  poisonDocumentImported: false,
  sentinelDocumentImported: false,
  createdAt: '2026-09-29T01:00:00.000Z',
  alignmentMode: 'KB_EXISTING',
  alignmentModeLabel: '已有知识库',
  alignmentConfirmedByName: 'admin',
  alignmentConfirmedAt: '2026-09-29T01:00:00.000Z',
  packageImported: false,
  indexProbe: null,
  uploads: null,
  cleanup: {
    attempted: false,
    ok: false,
    reason: '未配置删除接口，平台上传的测试文档仍留在被测知识库中，请手工删除',
    residual: [{ filename: 'lse-rag-poison.md', knowledgeBaseId: 'kb-test', documentId: 'doc-9', error: null }],
    deleted: 0,
  },
};

function metric(key: string, label: string, over: Record<string, unknown> = {}) {
  return { key, label, applicable: 2, samples: 2, passed: 1, passRate: 0.5, average: 0.5, notEvaluated: 0, notEvaluatedReasons: [], ...over };
}

export const groups = {
  generation: [
    metric('correctness', '正确性'),
    metric('faithfulness', '忠实度', {
      samples: 0,
      passRate: null,
      average: null,
      notEvaluated: 2,
      notEvaluatedReasons: [{ reason: '未评估：被测对象未配置检索上下文路径', count: 2 }],
    }),
    metric('refusal', '无答案拒答', { applicable: 1, samples: 1, passed: 0, passRate: 0, extra: { needsReview: 1 } }),
    metric('citation', '引用准确性'),
  ],
  retrieval: [metric('hitAtK', '命中率 Hit@k', { applicable: 0, samples: 0, passRate: null }), metric('mrr', 'MRR', { applicable: 0, samples: 0 })],
  retrievalStats: { hitAtK: null, mrr: null, samples: 0 },
  security: [metric('POISON', '文档投毒', { applicable: 1, samples: 1, passed: 0, passRate: 0 })],
};

export function result(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(Math.random()),
    question: '问题',
    referenceAnswer: null,
    response: '回复',
    status: 'SUCCESS',
    errorMessage: null,
    correctness: null,
    faithfulness: null,
    refusalOk: null,
    citationAccuracy: null,
    injectionFollowed: null,
    sentinelLeaked: null,
    verdict: 'PASS',
    reason: null,
    latencyMs: 10,
    needsReview: false,
    notEvaluated: null,
    ...over,
  };
}
