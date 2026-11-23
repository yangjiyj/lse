import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAV_SECTIONS } from '@/components/nav-config';
import { SystemStatusPage, STATUS_REFRESH_MS } from './SystemStatusPage';

const apiMock = vi.hoisted(() => ({ status: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { system: { status: apiMock.status } },
}));

const GB = 1024 ** 3;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    cpu: { cores: 8, load1: 0.52, load5: 0.61, usagePercent: 37.5 },
    memory: { total: 16 * GB, used: 12 * GB },
    disks: [
      { mount: '/', total: 100 * GB, used: 40 * GB },
      { mount: '/var/lib/lse/model-scan-uploads', total: 500 * GB, used: 450 * GB },
    ],
    uptimeSeconds: 3 * 86400 + 4 * 3600 + 120,
    checkedAt: '2026-11-17T13:00:00.000Z',
    dependencies: { database: 'ok', redis: 'error' },
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SystemStatusPage />
    </QueryClientProvider>,
  );
}

describe('SystemStatusPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.status.mockResolvedValue(payload());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('展示 CPU、内存、磁盘、运行时长和依赖状态', async () => {
    renderPage();
    expect(await screen.findByText('37.5%')).toBeInTheDocument();
    expect(screen.getByText('8 核 · 负载 0.52 / 0.61')).toBeInTheDocument();
    expect(screen.getByText('75.0%')).toBeInTheDocument();
    expect(screen.getByText('12.0 GB / 16.0 GB')).toBeInTheDocument();
    expect(screen.getByText('3 天 4 小时')).toBeInTheDocument();
    expect(screen.getByText('平台已运行')).toBeInTheDocument();

    const disks = screen.getByRole('table');
    expect(within(disks).getByText('/var/lib/lse/model-scan-uploads')).toBeInTheDocument();
    expect(within(disks).getByText('450.0 GB / 500.0 GB')).toBeInTheDocument();
    expect(within(disks).getByText('90.0%')).toBeInTheDocument();

    const db = screen.getByText('数据库').closest('li')!;
    expect(within(db).getByText('正常')).toBeInTheDocument();
    const redis = screen.getByText('Redis').closest('li')!;
    expect(within(redis).getByText('异常')).toBeInTheDocument();
  });

  it('每 30 秒刷新一次', async () => {
    expect(STATUS_REFRESH_MS).toBe(30_000);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage();
    await screen.findByText('37.5%');
    expect(apiMock.status).toHaveBeenCalledTimes(1);
    apiMock.status.mockResolvedValue(
      payload({ cpu: { cores: 8, load1: 1, load5: 1, usagePercent: 80 } }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS);
    });
    expect(apiMock.status).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('80.0%')).toBeInTheDocument();
  });

  it('无权查看时显示原因', async () => {
    apiMock.status.mockRejectedValue(new Error('仅平台管理员可查看运行状态'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('仅平台管理员可查看运行状态');
  });
});

describe('运行状态菜单', () => {
  it('在「系统管理」下，只给平台管理员', () => {
    const section = NAV_SECTIONS.find((s) => s.label === '系统管理')!;
    const item = section.groups.flatMap((g) => g.items).find((i) => i.path === '/system/status');
    expect(item).toMatchObject({
      label: '运行状态',
      permission: 'tenant:manage',
      platformOnly: true,
    });
  });
});
