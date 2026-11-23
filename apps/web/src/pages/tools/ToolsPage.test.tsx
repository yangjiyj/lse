import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import type { ToolListItem } from '@/lib/tools';
import { ToolsPage } from './ToolsPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  perms: new Set<string>(['tool:read']),
}));

vi.mock('@/lib/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tools')>()),
  toolsApi: { list: mocks.list },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => mocks.perms.has(code) }),
}));

const TS = '2026-11-21T08:00:00.000Z';
const ITEM: ToolListItem = {
  id: 't1',
  code: 'model-scanner',
  name: '模型扫描器',
  category: 'model',
  description: '扫描模型文件',
  taskEntry: 'model-file-scan',
  task: null,
  enabled: false,
  hidden: false,
  builtin: false,
  latestVersion: { version: '1.2.0', createdAt: TS },
  platforms: [{ os: 'windows', arch: 'amd64' }],
  versionCount: 1,
  downloadCount: 7,
  createdAt: TS,
  updatedAt: TS,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <ToolsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ToolsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = new Set(['tool:read']);
    mocks.list.mockResolvedValue({ items: [ITEM] });
  });

  it('列出工具：类别、禁用标记、系统架构、最新版本和下载量', async () => {
    renderPage();
    expect(await screen.findByText('模型扫描器')).toBeInTheDocument();
    expect(screen.getByText('已禁用')).toBeInTheDocument();
    expect(screen.getByText('Windows · x86-64')).toBeInTheDocument();
    expect(screen.getByText('1.2.0')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /模型扫描器/ })).toHaveAttribute('href', '/tools/t1');
  });

  it('筛选的类别、系统、架构、关键词传给接口', async () => {
    renderPage();
    await screen.findByText('模型扫描器');
    expect(mocks.list).toHaveBeenLastCalledWith({
      category: undefined,
      os: undefined,
      arch: undefined,
      keyword: undefined,
    });
    await userEvent.selectOptions(screen.getByLabelText('类别'), 'data');
    await userEvent.selectOptions(screen.getByLabelText('操作系统'), 'windows');
    await userEvent.selectOptions(screen.getByLabelText('硬件架构'), 'arm64');
    await userEvent.type(screen.getByLabelText('搜索工具'), 'scan');
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith({
        category: 'data',
        os: 'windows',
        arch: 'arm64',
        keyword: 'scan',
      }),
    );
  });

  it('没有 tool:manage 时不出现「新建工具」', async () => {
    renderPage();
    await screen.findByText('模型扫描器');
    expect(screen.queryByRole('button', { name: /新建工具/ })).not.toBeInTheDocument();
  });

  it('有 tool:manage 时可以新建工具', async () => {
    mocks.perms = new Set(['tool:read', 'tool:manage']);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /新建工具/ }));
    expect(screen.getByRole('dialog', { name: '新建工具' })).toBeInTheDocument();
    expect(screen.getByLabelText(/编码/)).toBeInTheDocument();
  });
});
