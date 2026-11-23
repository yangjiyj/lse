import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { EndpointTaskSummary } from '@/lib/api';
import { ToastProvider } from '@/components/ui/toast';
import { LiveResultsTable } from './LiveResultsTable';

vi.mock('@/lib/api', () => ({ api: { fleet: {}, modelTargets: {}, agentSamples: { list: vi.fn() } } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('@/components/SensitiveText', () => ({ SensitiveText: ({ text }: { text: string }) => <span>{text}</span> }));

const base: EndpointTaskSummary = {
  mode: 'live',
  endpointId: 'ep1',
  product: 'claude-code',
  endpoint: { name: '研发终端', lastSeenAt: null },
  agents: [],
  verdictLine: '测评进行中：终端已领取任务，共 120 个场景，预计总用时约 5 小时。结果在终端全部跑完后统一回传，期间不判定。',
  groups: [],
  liveScenarios: [],
  progress: { state: 'running', total: 120, startedAt: '2026-11-02T00:25:00.000Z', estimateSeconds: 19200 },
};

function renderTable(summary: EndpointTaskSummary) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ToastProvider>
          <LiveResultsTable summary={summary} taskId="t1" running targetId="target-1" />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('任务进行中显示进度和预计完成时间，不显示无效统计、结果表和复测按钮', () => {
  renderTable(base);
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('测评进行中');
  expect(status).toHaveTextContent(/2026\D11\D0[12]/);
  expect(status).toHaveTextContent('预计');
  expect(screen.queryByText('无效')).not.toBeInTheDocument();
  expect(screen.queryByText('证据不足')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '复测所选' })).not.toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

it('等待终端领取时同样不显示结果表', () => {
  renderTable({ ...base, verdictLine: '测评已下发，等待终端领取并开始：共 120 个场景。', progress: { state: 'queued', total: 120, startedAt: null, estimateSeconds: null } });
  expect(screen.getByRole('status')).toHaveTextContent('等待终端领取');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
