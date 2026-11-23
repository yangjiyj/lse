import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { RagEvalPage } from './RagEvalPage';
import { mt, corpus, groups, m, ragTarget, result, run, testSet } from './rag-eval/test-fixtures';

const perms = new Set(['rag_eval:read', 'rag_eval:manage', 'rag_eval:run']);
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: (c: string) => perms.has(c) }) }));
vi.mock('@/lib/api', async () => {
  const f = await import('./rag-eval/test-fixtures');
  return { ApiError: class ApiError extends Error {}, ragEvalApi: f.m, api: { modelTargets: f.mt } };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <RagEvalPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const step = async (name: RegExp) => fireEvent.click(await screen.findByRole('button', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  mt.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
  m.status.mockResolvedValue({
    judgeConfigured: true,
    judgeModelName: '评估模型A',
    message: null,
    judgeSettingsPath: '/settings#independent-judge-model',
    maxDocumentBytes: 10 * 1024 * 1024,
    formats: ['txt', 'md', 'pdf', 'docx'],
  });
  m.targets.mockResolvedValue([ragTarget]);
  m.corpora.mockResolvedValue([corpus]);
  m.documents.mockResolvedValue([
    { id: 'd1', corpusId: 'c1', filename: '差旅制度.pdf', format: 'pdf', sizeBytes: 2048, textLength: 500, chunkCount: 3, createdAt: '2026-09-29T00:00:00.000Z' },
  ]);
  m.testSets.mockResolvedValue([testSet]);
  m.testSet.mockResolvedValue({
    id: 's1', name: '制度测试集', seed: 'seed-1', promptVersion: 'v2', judgeModelName: null,
    corpus: { id: 'c1', name: '制度库' }, generationStatus: 'READY',
    items: [{ id: 'i1', type: 'FACT', question: '报销期限是多久？', referenceAnswer: '30 天', sourceChunkIds: ['k1'], origin: 'GENERATED' }],
    sources: [{ id: 'k1', seq: 0, filename: '差旅制度.pdf', content: '...' }],
  });
  m.downloadTestPackage.mockResolvedValue(undefined);
  m.runs.mockResolvedValue([run]);
  m.run.mockResolvedValue({ ...run, metrics: [], groups, capabilities: { citationConfigured: false, knowledgeUploadConfigured: false, restrictedKnowledgeBaseConfigured: false } });
  m.results.mockResolvedValue({
    items: [
      result({ itemType: 'NO_ANSWER', question: '公司股票代码？', verdict: 'UNKNOWN', needsReview: true, reason: '未拒答但给出答案，需人工复核', retrievedContext: ['上下文片段甲'], notEvaluated: { faithfulness: '未配置检索上下文路径' } }),
    ],
    total: 1, page: 1, pageSize: 20,
  });
});

describe('RagEvalPage 步骤条', () => {
  it('五个步骤依次为模式、文档、测试集、配置检查、运行与结果', async () => {
    renderPage();
    const bar = await screen.findByRole('list', { name: '评估步骤' });
    const labels = within(bar).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['1选对象与试连', '2知识对齐', '3测试文档', '4选测试集', '5运行与结果']);
    expect(screen.getByRole('heading', { name: /选对象与试连/ })).toBeInTheDocument();
  });

  it('第 2 步知识库列表显示文件名、类型、切块数与状态', async () => {
    renderPage();
    await step(/^3\s*测试文档$/);
    const row = (await screen.findByText('差旅制度.pdf')).closest('tr')!;
    expect(within(row).getByText('PDF')).toBeInTheDocument();
    expect(within(row).getByText('已切块')).toBeInTheDocument();
  });

  it('第 3 步：测试集显示对齐模式与状态，选中后可下载测试知识库包、导入导出与增删改', async () => {
    renderPage();
    await step(/^4\s*选测试集$/);
    const row = (await screen.findByText('制度测试集')).closest('tr')!;
    expect(within(row).getByText('已有知识库')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: '选择并查看题目' }));
    expect(await screen.findByText('报销期限是多久？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下载测试知识库包（zip）' }));
    expect(m.downloadTestPackage).toHaveBeenCalledWith('s1');
    for (const n of ['导出 CSV', '导出 JSONL', '新增题目', '导入 CSV/JSONL', '编辑', '删除']) {
      expect(screen.getAllByRole('button', { name: n }).length).toBeGreaterThan(0);
    }
  });

  it('第 3 步：生成中显示进度并可取消', async () => {
    m.testSets.mockResolvedValue([{ ...testSet, generationStatus: 'GENERATING', generationProgress: { planned: 14, done: 5, generated: 4, failed: 1 } }]);
    m.cancelGeneration.mockResolvedValue({ ok: true });
    renderPage();
    await step(/^4\s*选测试集$/);
    expect(await screen.findByLabelText('生成进度')).toHaveTextContent('5/14（成功 4，失败 1）');
    fireEvent.click(screen.getByRole('button', { name: '取消生成' }));
    await waitFor(() => expect(m.cancelGeneration).toHaveBeenCalledWith('s1'));
  });

  it('第 4 步：没有 RAG 对象时写清缺什么、去哪配', async () => {
    m.targets.mockResolvedValue([]);
    renderPage();
    await step(/^1\s*选对象与试连$/);
    expect(await screen.findByText(/还没有 RAG 评估对象/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '评估对象' })).toHaveAttribute('href', '/model-targets');
  });

  it('第 4 步：按模式请求配置检查清单并展示未配置项的影响', async () => {
    renderPage();
    await step(/^2\s*知识对齐$/);
    fireEvent.click(await screen.findByRole('radio', { name: /检索接口直评/ }));
    await step(/^1\s*选对象与试连$/);
    const list = await screen.findByRole('list', { name: '配置检查清单' });
    expect(within(list).getByText('检索上下文路径')).toBeInTheDocument();
    expect(list.textContent).not.toContain('contextPath');
    expect(within(list).getByText('未配置时忠实度记“未评估”')).toBeInTheDocument();
    expect(m.targets).toHaveBeenCalledWith('RETRIEVAL_API');
  });
});
