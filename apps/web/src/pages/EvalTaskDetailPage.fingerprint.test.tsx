import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { EvalTaskDetailPage } from './EvalTaskDetailPage';

const apiMock = vi.hoisted(() => ({
  getTask: vi.fn(),
  results: vi.fn(),
  findings: vi.fn(),
  logs: vi.fn(),
  listModelTargets: vi.fn(),
  taskScore: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    evalTasks: {
      get: apiMock.getTask,
      results: apiMock.results,
      findings: apiMock.findings,
      explainResult: vi.fn(),
      logs: apiMock.logs,
      reEval: vi.fn(),
    },
    reports: { create: vi.fn() },
    modelTargets: { list: apiMock.listModelTargets },
    evaluationConfig: { taskScore: apiMock.taskScore },
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => code !== 'eval_task:log_view' }),
}));

const task = {
  id: '22222222-2222-4222-8222-222222222222',
  name: '指纹比对任务',
  description: null,
  status: 'COMPLETED',
  modelTarget: { id: 'model-1', name: '测试模型', provider: 'openai', model: 'gpt-test' },
  engines: ['rule-judge'],
  dimensions: ['prompt_injection'],
  concurrency: 4,
  totalQuestions: 10,
  processedQuestions: 10,
  passedCount: 10,
  failedCount: 0,
  errorCount: 0,
  progress: 1,
  questionSets: [],
  resultCount: 10,
  logCount: 0,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-09-29T08:00:00.000Z',
  updatedAt: '2026-09-29T08:00:00.000Z',
};

const check = (extra: Record<string, unknown>) => ({
  status: 'OK',
  similarity: 0.91,
  threshold: 0.6,
  baselineId: 'fp-base-1',
  fingerprintId: 'fp-new-1',
  reason: null,
  checkedAt: '2026-09-29T08:00:00.000Z',
  ...extra,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/eval-tasks/' + task.id]}>
        <ToastProvider>
          <Routes>
            <Route path="/eval-tasks/:id" element={<EvalTaskDetailPage />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EvalTaskDetailPage 模型指纹前置比对', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiMock.taskScore.mockResolvedValue({ score: null, judgedCount: 0, dimensions: [] });
    apiMock.results.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    apiMock.findings.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    apiMock.logs.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    apiMock.listModelTargets.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
  });

  it('OK：显示一致与相似度', async () => {
    apiMock.getTask.mockResolvedValue({ ...task, fingerprintCheck: check({ status: 'OK' }) });
    renderPage();
    const row = await screen.findByRole('region', { name: '模型指纹前置比对' });
    expect(row).toHaveTextContent('一致，相似度 0.91');
    expect(row).not.toHaveTextContent('疑似模型被替换');
  });

  it('DRIFT：红色提示疑似被替换并附基线说明', async () => {
    apiMock.getTask.mockResolvedValue({
      ...task,
      fingerprintCheck: check({ status: 'DRIFT', similarity: 0.42 }),
    });
    renderPage();
    const row = await screen.findByRole('region', { name: '模型指纹前置比对' });
    const warn = screen.getByText(/疑似模型被替换，相似度 0\.42，低于阈值/);
    expect(warn).toHaveTextContent('低于阈值 0.60');
    expect(warn.className).toContain('text-severity-critical');
    expect(row).toHaveTextContent('基线指纹 fp-base-1');
    expect(screen.getByRole('link', { name: '评估对象' })).toHaveAttribute(
      'href',
      '/model-targets',
    );
  });

  it('FAILED：显示原因且注明不影响任务执行', async () => {
    apiMock.getTask.mockResolvedValue({
      ...task,
      fingerprintCheck: check({ status: 'FAILED', similarity: null, reason: '探针请求超时' }),
    });
    renderPage();
    const row = await screen.findByRole('region', { name: '模型指纹前置比对' });
    expect(row).toHaveTextContent('比对未完成：探针请求超时（不影响任务执行）');
  });

  it('NO_BASELINE：显示未设基线', async () => {
    apiMock.getTask.mockResolvedValue({
      ...task,
      fingerprintCheck: check({ status: 'NO_BASELINE', similarity: null, baselineId: null }),
    });
    renderPage();
    const row = await screen.findByRole('region', { name: '模型指纹前置比对' });
    expect(row).toHaveTextContent('未设基线');
  });

  it('fingerprintCheck 为 null 时不显示该行', async () => {
    apiMock.getTask.mockResolvedValue({ ...task, fingerprintCheck: null });
    renderPage();
    expect(await screen.findByText('指纹比对任务')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '模型指纹前置比对' })).not.toBeInTheDocument();
  });
});
