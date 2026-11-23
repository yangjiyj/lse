import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BankVersionInfo } from './BankUpdateInfo';

const mocks = vi.hoisted(() => ({ bankUpdates: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { questionSets: { bankUpdates: mocks.bankUpdates } },
}));

const overview = {
  canRun: true,
  items: [{ id: 'a', kind: 'questions', version: '2026.11.4', trigger: 'schedule', status: 'succeeded' }],
  questions: { version: '2026.11.4', updatedAt: '2026-11-14T16:30:00.000Z', cadence: '每月 1 日自动更新', nextRunAt: '2026-11-30T19:00:00.000Z', running: false },
  keywords: { version: '2026-11-17', updatedAt: '2026-11-17T03:00:00.000Z', lastAdded: 12, cadence: '每周一自动补充', nextRunAt: '2026-11-23T19:00:00.000Z', running: false },
};

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bankUpdates.mockResolvedValue(overview);
});

describe('题库版本信息', () => {
  it('只写题库版本；不显示更新周期、下次时间、立即更新和更新记录', async () => {
    const { container } = renderWith(<BankVersionInfo />);
    expect(await screen.findByText('题库版本 2026.11.4')).toBeInTheDocument();
    expect(container.textContent).toBe('题库版本 2026.11.4');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('没有版本号或接口不可用时整块不显示', async () => {
    mocks.bankUpdates.mockRejectedValue(new Error('x'));
    const { container } = renderWith(<BankVersionInfo />);
    await waitFor(() => expect(mocks.bankUpdates).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
