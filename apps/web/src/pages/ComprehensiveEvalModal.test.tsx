import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { ComprehensiveEvalModal } from './ComprehensiveEvalModal';

const apiMock = vi.hoisted(() => ({
  listModels: vi.fn(),
  capabilities: vi.fn(),
  listQuestionSets: vi.fn(),
  createComprehensive: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    evalTasks: { createComprehensive: apiMock.createComprehensive },
    modelTargets: { list: apiMock.listModels, capabilities: apiMock.capabilities },
    questionSets: { list: apiMock.listQuestionSets },
  },
}));

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <ComprehensiveEvalModal open onClose={() => {}} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.listModels.mockResolvedValue({ items: [], total: 0 });
  apiMock.capabilities.mockResolvedValue({ platformAppEnabled: false });
  apiMock.listQuestionSets.mockResolvedValue({
    items: [
      { id: 'set-on', name: '启用的回归库', questionCount: 12, enabled: true },
      { id: 'set-off', name: '已停用的回归库', questionCount: 8, enabled: false },
    ],
    total: 2,
  });
});

describe('综合评估：样本库回归', () => {
  it('可选的回归样本库不含已禁用的', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole('checkbox', { name: /样本库回归评估/ }));
    expect(await screen.findByRole('checkbox', { name: /启用的回归库/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /已停用的回归库/ })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(apiMock.listQuestionSets).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      ),
    );
  });
});
