import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { AdrTraceImportModal } from './AdrTraceImportModal';

const apiMock = vi.hoisted(() => ({
  listTargets: vi.fn(),
  importAdrTrace: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    modelTargets: { list: apiMock.listTargets },
    agentEvals: { importAdrTrace: apiMock.importAdrTrace },
  },
}));

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiMock.listTargets.mockReset();
  apiMock.importAdrTrace.mockReset();
  apiMock.listTargets.mockResolvedValue({
    items: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: '客户代码智能体',
        model: 'agent',
        targetType: 'AGENT_API',
        isActive: true,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: '裁判模型',
        model: 'judge',
        targetType: 'JUDGE',
        isActive: true,
      },
    ],
    total: 2,
    page: 1,
    pageSize: 200,
  });
  apiMock.importAdrTrace.mockResolvedValue({
    taskId: 'task-adr-1',
    summary: {
      entryCount: 1,
      messageCount: 1,
      toolCallCount: 0,
      findingCount: 0,
      riskSessionCount: 0,
      passedSessionCount: 1,
      failedFindingCount: 0,
      reviewFindingCount: 0,
      truncatedSessionCount: 0,
    },
  });
});

describe('AdrTraceImportModal', () => {
  it('选择对象和 JSON 后调用无端轨迹导入接口，且不展示裁判模型', async () => {
    const user = userEvent.setup();
    render(wrap(<AdrTraceImportModal open={true} onClose={() => {}} />));

    await screen.findByText(/客户代码智能体/);
    expect(screen.queryByText(/裁判模型/)).not.toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText(/轨迹归属对象/),
      '11111111-1111-4111-8111-111111111111',
    );

    const payload = {
      timestamp: '2026-08-11T03:00:00Z',
      source: 'codex',
      session_id: 'raw-session',
      chat_history: [{ role: 'user', content: 'hello', tools: [] }],
    };
    const file = new File([JSON.stringify(payload)], 'adr.json', {
      type: 'application/json',
    });
    await user.upload(screen.getByLabelText(/ADR-compatible JSON/), file);
    await screen.findByText(/检测到约 1 个会话/);
    await user.click(screen.getByRole('button', { name: /导入并分析/ }));

    await waitFor(() => expect(apiMock.importAdrTrace).toHaveBeenCalledTimes(1));
    expect(apiMock.importAdrTrace).toHaveBeenCalledWith({
      modelTargetId: '11111111-1111-4111-8111-111111111111',
      name: undefined,
      payload,
    });
  });
});
