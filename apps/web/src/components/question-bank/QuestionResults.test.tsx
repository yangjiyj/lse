import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { QuestionResults } from './QuestionResults';

const apiMock = vi.hoisted(() => ({ questionResults: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { questionSets: { questionResults: apiMock.questionResults } },
}));

function record(i: number) {
  return {
    taskId: `task-${i}`,
    taskName: `任务 ${i}`,
    targetName: '生产模型',
    verdict: 'PASS',
    severity: null,
    createdAt: '2026-11-03T00:00:00.000Z',
  };
}

function renderResults() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <QuestionResults setId="set-1" questionId="q-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('QuestionResults 检测记录', () => {
  beforeEach(() => vi.clearAllMocks());

  it('记录超过返回条数时显示「最近 200 条，共 N 条」', async () => {
    apiMock.questionResults.mockResolvedValue({
      items: Array.from({ length: 200 }, (_, i) => record(i)),
      total: 345,
    });
    renderResults();
    await userEvent.click(screen.getByRole('button', { name: '检测记录' }));
    expect(await screen.findByText('最近 200 条，共 345 条')).toBeInTheDocument();
  });

  it('全部返回时不显示条数提示', async () => {
    apiMock.questionResults.mockResolvedValue({ items: [record(1), record(2)], total: 2 });
    renderResults();
    await userEvent.click(screen.getByRole('button', { name: '检测记录' }));
    expect(await screen.findByRole('link', { name: '任务 1' })).toBeInTheDocument();
    expect(screen.queryByText(/^最近 /)).not.toBeInTheDocument();
  });
});
