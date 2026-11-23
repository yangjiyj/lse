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

async function goRun() {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: /^5\s*运行与结果$/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mt.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
  m.status.mockResolvedValue({ judgeConfigured: true, judgeModelName: 'A', message: null, maxDocumentBytes: 1, formats: [] });
  m.targets.mockResolvedValue([ragTarget]);
  m.corpora.mockResolvedValue([corpus]);
  m.testSets.mockResolvedValue([testSet]);
  m.runs.mockResolvedValue([run]);
  m.run.mockResolvedValue({ ...run, metrics: [], groups, capabilities: { citationConfigured: false, knowledgeUploadConfigured: false, restrictedKnowledgeBaseConfigured: false } });
  m.results.mockResolvedValue({
    items: [
      result({
        itemType: 'NO_ANSWER',
        question: '公司股票代码？',
        verdict: 'UNKNOWN',
        needsReview: true,
        reason: '未拒答但给出答案，需人工复核',
        retrievedContext: ['上下文片段甲'],
        notEvaluated: { faithfulness: '未配置检索上下文路径' },
      }),
    ],
    total: 1,
    page: 1,
    pageSize: 20,
  });
});

describe('RagEvalPage 运行与结果', () => {
  it('模式 A 发起时带上知识对齐确认', async () => {
    m.createRun.mockResolvedValue({ id: 'r1', taskId: 'k1', status: 'PENDING' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^1\s*选对象与试连$/ }));
    fireEvent.click(await screen.findByRole('button', { name: '试连' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '下一步：知识对齐' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^5\s*运行与结果$/ }));
    const btn = await screen.findByRole('button', { name: '发起评估' });
    fireEvent.click(await screen.findByLabelText(/我确认：这些文档已在被测系统知识库中并完成索引/));
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await waitFor(() =>
      expect(m.createRun).toHaveBeenCalledWith({
        testSetId: 's1',
        modelTargetId: 't1',
        alignmentConfirmed: true,
        packageImported: false,
        poisonDocumentImported: false,
        sentinelDocumentImported: false,
      }),
    );
  });

  it('测试知识库包模式未配置上传接口时提供“已导入”勾选与包下载入口', async () => {
    m.testSets.mockResolvedValue([{ ...testSet, alignmentMode: 'TEST_PACKAGE', alignmentModeLabel: '测试知识库包' }]);
    m.downloadTestPackage.mockResolvedValue(undefined);
    await goRun();
    expect(await screen.findByLabelText(/已把测试知识库包手工导入/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/我确认：这些文档已在被测系统知识库中/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下载测试知识库包' }));
    expect(m.downloadTestPackage).toHaveBeenCalledWith('s1');
    expect(m.targets).toHaveBeenCalledWith('TEST_PACKAGE');
  });

  it('只读+发起权限（无维护权限）不显示测试知识库包下载入口（包含投毒/哨兵原文）', async () => {
    perms.delete('rag_eval:manage');
    m.testSets.mockResolvedValue([{ ...testSet, alignmentMode: 'TEST_PACKAGE', alignmentModeLabel: '测试知识库包' }]);
    await goRun();
    expect(await screen.findByLabelText(/已把测试知识库包手工导入/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载测试知识库包' })).toBeNull();
    perms.add('rag_eval:manage');
  });

  it('模式 A 配置了上传接口：明确提示会自动上传哪些测试文档、用途与清理行为', async () => {
    m.targets.mockResolvedValue([
      { ...ragTarget, knowledgeUploadConfigured: true, knowledgeDeleteConfigured: false, restrictedKnowledgeBaseConfigured: true, restrictedCredentialConfigured: true },
    ]);
    await goRun();
    const note = await screen.findByRole('note', { name: '自动上传测试文档说明' });
    expect(within(note).getByText(/lse-rag-poison-test\.md/)).toBeInTheDocument();
    expect(within(note).getByText(/文档投毒与间接提示词注入/)).toBeInTheDocument();
    expect(within(note).getByText(/lse-rag-sentinel-test\.md/)).toBeInTheDocument();
    expect(within(note).getByText(/受限库上传凭据/)).toBeInTheDocument();
    expect(within(note).getByText(/未配置删除接口：评估结束后这些测试文档会留在被测知识库中/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/已人工导入投毒测试文档/)).toBeNull();
  });

  it('模式 A 配置了上传与删除接口、未配置受限库：只提示投毒文档，并说明结束后自动删除', async () => {
    m.targets.mockResolvedValue([{ ...ragTarget, knowledgeUploadConfigured: true, knowledgeDeleteConfigured: true }]);
    await goRun();
    const note = await screen.findByRole('note', { name: '自动上传测试文档说明' });
    expect(within(note).queryByText(/lse-rag-sentinel-test\.md/)).toBeNull();
    expect(within(note).getByText(/无论成功、失败还是取消，都会调用删除接口删除本次上传的测试文档/)).toBeInTheDocument();
  });

  it('模式 A 未配置上传接口：不显示自动上传提示', async () => {
    await goRun();
    await screen.findByRole('button', { name: '发起评估' });
    expect(screen.queryByRole('note', { name: '自动上传测试文档说明' })).toBeNull();
  });

  it('必需配置未就绪、测试集无题时列出阻塞原因并禁用发起', async () => {
    m.targets.mockResolvedValue([{ ...ragTarget, ready: false }]);
    m.testSets.mockResolvedValue([{ ...testSet, itemCount: 0 }]);
    await goRun();
    expect(await screen.findByText('测试集没有题目（请生成、导入或新增）')).toBeInTheDocument();
    expect(screen.getByText('被测对象必需配置未就绪（见下方清单）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发起评估' })).toBeDisabled();
  });

  it('结果按生成质量/检索质量/安全项分组，写明未评估原因、需人工复核与残留清单，可单题下钻', async () => {
    await goRun();
    fireEvent.click(await screen.findByRole('button', { name: '查看结果' }));
    expect(await screen.findByRole('dialog', { name: '评估结果' })).toBeInTheDocument();
    const gen = await screen.findByRole('region', { name: '生成质量' });
    const faith = within(gen).getByText('忠实度').closest('tr')!;
    expect(within(faith).getByText('未评估（被测对象未配置检索上下文路径）')).toBeInTheDocument();
    expect(within(gen).getByText('需人工复核 1')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '检索质量' })).toBeNull();
    expect(screen.getByText('本次未涉及：检索质量')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '安全项' })).toBeInTheDocument();
    expect(screen.getByText(/已由 admin 于/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '残留清单' })).getByText(/lse-rag-poison.md/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('按结论筛选'), { target: { value: 'review' } });
    await waitFor(() => expect(m.results).toHaveBeenLastCalledWith('r1', expect.objectContaining({ needsReview: 'true' })));
    const q = (await screen.findByText('公司股票代码？')).closest('tr')!;
    expect(within(q).getByText('需人工复核')).toBeInTheDocument();
    fireEvent.click(within(q).getByRole('button', { name: '详情' }));
    expect(await screen.findByText('上下文片段甲')).toBeInTheDocument();
    expect(screen.getByText('忠实度：未配置检索上下文路径')).toBeInTheDocument();
    expect(screen.getByText('未返回引用（空引用不计分）')).toBeInTheDocument();
  });

  it('运行中可取消', async () => {
    m.runs.mockResolvedValue([{ ...run, status: 'RUNNING' }]);
    m.cancelRun.mockResolvedValue({ ok: true });
    await goRun();
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    await waitFor(() => expect(m.cancelRun).toHaveBeenCalledWith('r1'));
  });

  it('评估模型未配置时提示去系统设置', async () => {
    m.status.mockResolvedValue({ judgeConfigured: false, judgeModelName: null, message: '未配置评估模型', maxDocumentBytes: 1, formats: [] });
    renderPage();
    const link = await screen.findByRole('link', { name: '去配置' });
    expect(link).toHaveAttribute('href', '/settings#independent-judge-model');
  });

  it('无查看权限时不请求接口', async () => {
    perms.delete('rag_eval:read');
    renderPage();
    expect(await screen.findByText('当前账号没有查看 RAG 专项评估的权限。')).toBeInTheDocument();
    expect(m.status).not.toHaveBeenCalled();
    perms.add('rag_eval:read');
  });
});

it('八十八条运行记录分页展示，切页后仍可查看对应结果', async () => {
  m.runs.mockResolvedValue(Array.from({ length: 88 }, (_, index) => ({ ...run, id: `r${index}`, modelTargetName: `测试对象${index}` })));
  await goRun();
  expect(await screen.findByText('第 1-10 条 / 共 88 条')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: '查看结果' })).toHaveLength(10);
  fireEvent.click(screen.getByRole('button', { name: /下一页/ }));
  expect(await screen.findByText('第 11-20 条 / 共 88 条')).toBeInTheDocument();
  expect(screen.getByText('测试对象10')).toBeInTheDocument();
  expect(screen.queryByText('测试对象0')).toBeNull();
});
