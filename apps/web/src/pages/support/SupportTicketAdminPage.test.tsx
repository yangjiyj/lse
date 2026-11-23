import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import type { SupportTicketDetail, SupportTicketManageItem } from '@/lib/support-tickets';
import { SupportTicketAdminPage } from './SupportTicketAdminPage';

const mocks = vi.hoisted(() => ({
  mine: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  reply: vi.fn(),
  close: vi.fn(),
  manage: vi.fn(),
  perms: new Set<string>(['support:manage']),
}));

vi.mock('@/lib/support-tickets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/support-tickets')>()),
  supportApi: {
    mine: mocks.mine,
    get: mocks.get,
    create: mocks.create,
    reply: mocks.reply,
    close: mocks.close,
    manage: mocks.manage,
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'admin', username: 'admin' },
    hasPermission: (code: string) => mocks.perms.has(code),
  }),
}));

const TS = '2026-11-17T08:00:00.000Z';
const ROW: SupportTicketManageItem = {
  id: 't9',
  kind: 'SUPPORT',
  title: '终端装不上',
  status: 'OPEN',
  createdBy: { id: 'u9', name: '甲单位管理员' },
  createdAt: TS,
  updatedAt: TS,
  replyCount: 0,
  tenantName: '甲单位',
};
const DETAIL: SupportTicketDetail = { ...ROW, content: '安装包报错', replies: [] };

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <SupportTicketAdminPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('SupportTicketAdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = new Set(['support:manage']);
    mocks.manage.mockResolvedValue({ items: [ROW], total: 1, page: 1, pageSize: 20 });
    mocks.get.mockResolvedValue(DETAIL);
    mocks.reply.mockResolvedValue({ ...DETAIL, status: 'REPLIED' });
    mocks.close.mockResolvedValue({ ...DETAIL, status: 'CLOSED' });
  });

  it('分「技术支持」「意见反馈」两个页签，列出全部租户的工单', async () => {
    renderPage();
    const tabs = await screen.findByRole('tablist');
    expect(within(tabs).getByRole('tab', { name: '技术支持' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByRole('cell', { name: '甲单位' })).toBeInTheDocument();
    expect(screen.getByText('终端装不上')).toBeInTheDocument();
    expect(mocks.manage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'SUPPORT' }));

    await userEvent.click(within(tabs).getByRole('tab', { name: '意见反馈' }));
    await waitFor(() =>
      expect(mocks.manage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'FEEDBACK' })),
    );
  });

  it('在详情里回复和关闭工单', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '终端装不上' }));
    const dialog = await screen.findByRole('dialog', { name: '终端装不上' });
    await within(dialog).findByText('安装包报错');
    await userEvent.type(within(dialog).getByLabelText('回复'), '请用管理员权限安装');
    await userEvent.click(within(dialog).getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledWith('t9', '请用管理员权限安装'));

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(within(dialog).getByRole('button', { name: '关闭工单' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledWith('t9'));
  });

  it('没有处理权限时不拉数据', async () => {
    mocks.perms = new Set();
    renderPage();
    expect(await screen.findByText('当前账号无此操作权限')).toBeInTheDocument();
    expect(mocks.manage).not.toHaveBeenCalled();
  });
});
