import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/toast';
import { GatewayDrillModal } from './GatewayDrillModal';

const apiMock = vi.hoisted(() => ({ drillPrepare: vi.fn() }));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { gatewayLogs: { drillPrepare: apiMock.drillPrepare } },
}));

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <GatewayDrillModal
          target={{ id: 't1', name: '客户A的智能体' } as never}
          onClose={() => {}}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('GatewayDrillModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('点「生成测试文件」→ 调 drillPrepare 并展示追踪码、网关规则与测试文件', async () => {
    apiMock.drillPrepare.mockResolvedValue({
      drill: {
        canaryToken: 'LSE-DRILL-abc',
        collectorUrl: 'https://drill-collector.invalid/echo',
        artifacts: [
          { channel: 'document', title: '产品需求说明 v2.3', content: '正文…注入 LSE-DRILL-abc' },
        ],
        successSignal: '业务部门 agent 在出口发出了本次演练诱饵 LSE-DRILL-abc',
        gatewayRule: {
          ruleType: 'keyword',
          pattern: 'LSE-DRILL-abc',
          action: 'audit',
          name: '演练诱饵检测 LSE-DRILL-abc',
        },
      },
      hint: '将工件交业务部门用其真 agent 处理…',
    });

    renderModal();
    await userEvent.click(screen.getByRole('button', { name: '生成测试文件' }));

    await waitFor(() => expect(apiMock.drillPrepare).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('LSE-DRILL-abc')).toBeInTheDocument(); // 追踪码 code 块（精确）
    expect(screen.getByText(/产品需求说明 v2\.3/)).toBeInTheDocument(); // 工件标题
    expect(screen.getByText(/仅记录并留证/)).toBeInTheDocument(); // 建议网关规则（action=audit → 仅记录）
  });
});
