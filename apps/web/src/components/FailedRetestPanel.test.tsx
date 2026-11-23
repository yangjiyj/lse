import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import type { EvalTaskRetestInfo } from '@/lib/api';
import { FailedRetestPanel } from './FailedRetestPanel';

const retestFailed = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { evalTasks: { retestFailed } },
}));

const TASK_ID = '11111111-1111-4111-8111-111111111111';

function renderPanel(retest: EvalTaskRetestInfo, canCreate = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/eval-tasks/${TASK_ID}`]}>
        <ToastProvider>
          <Routes>
            <Route
              path="/eval-tasks/:id"
              element={<FailedRetestPanel taskId={TASK_ID} retest={retest} canCreate={canCreate} />}
            />
            <Route path="/eval-tasks/new-retest" element={<div>复测任务页</div>} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const base: EvalTaskRetestInfo = {
  retestOf: null,
  failedQuestionCount: 3,
  retestBlockedReason: null,
  retestTasks: [],
};

describe('FailedRetestPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('父任务有失败用例：点击“重跑失败用例”调用接口并跳转到新任务', async () => {
    retestFailed.mockResolvedValue({
      task: { id: 'new-retest', name: 'x', status: 'PENDING' },
      questionIds: ['a', 'b', 'c'],
      findingId: null,
    });
    renderPanel(base);
    expect(screen.getByText(/本任务判定为失败或执行异常的用例 3 道/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重跑失败用例' }));
    await waitFor(() => expect(retestFailed).toHaveBeenCalledWith(TASK_ID));
    expect(await screen.findByText('复测任务页')).toBeInTheDocument();
  });

  it('无失败用例时按钮禁用并显示原因', () => {
    renderPanel({
      ...base,
      failedQuestionCount: 0,
      retestBlockedReason: '本任务没有判定为失败或执行异常的用例。',
    });
    expect(screen.getByRole('button', { name: '重跑失败用例' })).toBeDisabled();
    expect(screen.getByText('本任务没有判定为失败或执行异常的用例。')).toBeInTheDocument();
  });

  it('复测任务显示“复测：x/y 已修复”与父任务链接', () => {
    renderPanel({
      ...base,
      retestOf: {
        parentTaskId: 'parent-1',
        parentTaskName: '原始评估任务',
        retestMode: 'FAILED_ONLY',
        total: 3,
        fixed: 2,
        stillFailing: 1,
        notRetested: 0,
      },
    });
    expect(screen.getByText('复测：2/3 已修复')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '原始评估任务' })).toBeInTheDocument();
  });

  it('无创建权限时不展示按钮；已发起的复测任务列出链接', () => {
    renderPanel(
      {
        ...base,
        retestTasks: [
          { id: 'r1', name: '复测一', status: 'COMPLETED', createdAt: '2026-09-29T01:00:00.000Z' },
        ],
      },
      false,
    );
    expect(screen.queryByRole('button', { name: '重跑失败用例' })).toBeNull();
    expect(screen.getByRole('button', { name: '复测一' })).toBeInTheDocument();
  });
});
