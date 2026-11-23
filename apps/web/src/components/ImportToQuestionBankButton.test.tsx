import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { ImportToQuestionBankButton } from './ImportToQuestionBankButton';

const apiMock = vi.hoisted(() => ({
  importToQuestionBank: vi.fn(),
  listQuestionSets: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    evalTasks: { importToQuestionBank: apiMock.importToQuestionBank },
    questionSets: { list: apiMock.listQuestionSets },
  },
}));

function renderButton() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/eval-tasks/t1']}>
          <Routes>
            <Route
              path="/eval-tasks/:id"
              element={<ImportToQuestionBankButton taskId="t1" taskName="红队任务" />}
            />
            <Route path="/question-sets" element={<div>题库列表页</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ImportToQuestionBankButton', () => {
  beforeEach(() => {
    apiMock.importToQuestionBank.mockReset();
    apiMock.listQuestionSets.mockReset();
  });

  it('新建自有题库：默认名称、最后一轮范围，成功后跳转题库列表', async () => {
    apiMock.importToQuestionBank.mockResolvedValue({ questionSetId: 's1', imported: 3, skipped: 0 });
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /导入题库/ }));
    expect(screen.getByLabelText('题库名称')).toHaveValue('红队任务 攻击题目');
    await user.click(screen.getByRole('button', { name: '确认导入' }));

    await waitFor(() =>
      expect(apiMock.importToQuestionBank).toHaveBeenCalledWith('t1', {
        mode: 'create',
        scope: 'last_round',
        name: '红队任务 攻击题目',
      }),
    );
    expect(await screen.findByText('题库列表页')).toBeInTheDocument();
  });

  it('追加模式只列出自有题库（排除内置题库）', async () => {
    apiMock.listQuestionSets.mockResolvedValue({
      items: [
        { id: 'b1', name: '内置题库', isBuiltin: true, questionCount: 10 },
        { id: 'o1', name: '自有题库A', isBuiltin: false, questionCount: 2 },
      ],
      total: 2,
    });
    apiMock.importToQuestionBank.mockResolvedValue({ questionSetId: 'o1', imported: 1, skipped: 2 });
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /导入题库/ }));
    await user.selectOptions(screen.getByLabelText('导入方式'), 'append');
    await screen.findByRole('option', { name: /自有题库A/ });
    expect(screen.queryByRole('option', { name: /内置题库/ })).toBeNull();

    await user.selectOptions(screen.getByLabelText('目标题库'), 'o1');
    await user.selectOptions(screen.getByLabelText('导入范围'), 'all_rounds');
    await user.click(screen.getByRole('button', { name: '确认导入' }));

    await waitFor(() =>
      expect(apiMock.importToQuestionBank).toHaveBeenCalledWith('t1', {
        mode: 'append',
        scope: 'all_rounds',
        questionSetId: 'o1',
      }),
    );
  });
});
