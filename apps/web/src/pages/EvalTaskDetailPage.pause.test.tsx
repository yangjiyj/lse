import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { EvalTaskDetailPage } from './EvalTaskDetailPage';

// 暂停、恢复后不用接口的精简返回覆盖详情缓存，而是重新拉取详情。
const apiMock = vi.hoisted(() => ({
  getTask: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  endpointSummary: vi.fn(),
  results: vi.fn(),
  explainResult: vi.fn(),
  findings: vi.fn(),
  logs: vi.fn(),
  exportLogs: vi.fn(),
  reEval: vi.fn(),
  createReport: vi.fn(),
  listModelTargets: vi.fn(),
  taskScore: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    evalTasks: {
      get: apiMock.getTask,
      pause: apiMock.pause,
      resume: apiMock.resume,
      cancel: apiMock.cancel,
      endpointSummary: apiMock.endpointSummary,
      results: apiMock.results,
      findings: apiMock.findings,
      explainResult: apiMock.explainResult,
      logs: apiMock.logs,
      exportLogs: apiMock.exportLogs,
      reEval: apiMock.reEval,
    },
    reports: { create: apiMock.createReport },
    modelTargets: { list: apiMock.listModelTargets },
    evaluationConfig: { taskScore: apiMock.taskScore },
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => code !== 'eval_task:log_view' }),
}));

const ID = '11111111-1111-4111-8111-111111111111';
const base = {
  id: ID,
  name: '可暂停任务',
  description: null,
  status: 'PENDING',
  pausable: true,
  pauseRequested: false,
  modelTarget: {
    id: 'model-1',
    name: '测试模型',
    provider: 'openai',
    model: 'gpt-test',
    targetType: 'MODEL',
  },
  engines: ['rule-judge'],
  dimensions: ['prompt_injection'],
  concurrency: 4,
  totalQuestions: 10,
  processedQuestions: 4,
  passedCount: 3,
  failedCount: 1,
  errorCount: 0,
  progress: 0.4,
  questionSets: [],
  resultCount: 4,
  logCount: 0,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-06-01T08:00:00.000Z',
  updatedAt: '2026-06-01T08:00:00.000Z',
};
// GET /:id 额外带的字段（withScore、reviewSummary、gatewayLinkageEnabled、retest）
const detailExtras = {
  evalScore: 75,
  riskLevels: { HIGH: 1, MEDIUM: 0, LOW: 0 },
  findingCount: 1,
  pendingReviewCount: 1,
  gatewayLinkageEnabled: false,
  retest: { retestOf: null, retestBlockedReason: null, retestTasks: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getTask.mockResolvedValue({ ...base, ...detailExtras });
  // POST /:id/pause 只返回 serializeTaskDetail + pauseRequested
  apiMock.pause.mockResolvedValue({
    ...base,
    status: 'PAUSED',
    pausedAt: '2026-06-01T08:01:00Z',
    pauseRequested: false,
  });
  apiMock.taskScore.mockResolvedValue({ score: null, judgedCount: 0, dimensions: [] });
  apiMock.results.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
  apiMock.findings.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
  apiMock.logs.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
  apiMock.listModelTargets.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
});

describe('评估任务详情：暂停、恢复', () => {
  it('排队中任务点暂停后重新拉取详情，详情里的复核、复测等字段不丢', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/eval-tasks/' + ID]}>
          <ToastProvider>
            <Routes>
              <Route path="/eval-tasks/:id" element={<EvalTaskDetailPage />} />
            </Routes>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const pauseBtn = await screen.findByRole('button', { name: /^暂停$/ });
    expect((qc.getQueryData(['eval-task', ID]) as Record<string, unknown>).findingCount).toBe(1);
    const callsBefore = apiMock.getTask.mock.calls.length;
    // 暂停后再拉详情：已暂停，且完整字段都在
    apiMock.getTask.mockResolvedValue({
      ...base,
      ...detailExtras,
      status: 'PAUSED',
      pausedAt: '2026-06-01T08:01:00Z',
    });
    await user.click(pauseBtn);
    await waitFor(() => expect(apiMock.pause).toHaveBeenCalled());
    await screen.findByRole('button', { name: /恢复/ });
    expect(apiMock.getTask.mock.calls.length).toBeGreaterThan(callsBefore);
    const cached = qc.getQueryData(['eval-task', ID]) as Record<string, unknown>;
    expect(cached.status).toBe('PAUSED');
    expect(cached.findingCount).toBe(1);
    expect(cached.retest).toBeDefined();
    expect(cached.evalScore).toBe(75);
  }, 15000);
});
