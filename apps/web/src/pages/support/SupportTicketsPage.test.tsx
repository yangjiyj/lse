import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import type { SupportTicketDetail, SupportTicketListItem } from '@/lib/support-tickets';
import { SupportTicketsPage } from './SupportTicketsPage';

const mocks = vi.hoisted(() => ({
  mine: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  reply: vi.fn(),
  close: vi.fn(),
  manage: vi.fn(),
}));

vi.mock('@/lib/support-tickets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/support-tickets')>()),
  supportApi: mocks,
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'alice' }, hasPermission: () => false }),
}));

const TS = '2026-11-17T08:00:00.000Z';
const OPEN: SupportTicketListItem = {
  id: 't1',
  kind: 'SUPPORT',
  title: '报告导不出来',
  status: 'REPLIED',
  createdBy: { id: 'u1', name: 'alice' },
  createdAt: TS,
  updatedAt: TS,
  replyCount: 1,
};
const DETAIL: SupportTicketDetail = {
  ...OPEN,
  content: '点导出没反应',
  replies: [
    {
      id: 'r1',
      content: '请升级到最新版本',
      author: { id: 'admin', name: '系统管理员' },
      byCreator: false,
      createdAt: TS,
    },
  ],
};

function renderPage(kind: 'SUPPORT' | 'FEEDBACK' = 'SUPPORT') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <SupportTicketsPage kind={kind} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('SupportTicketsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mine.mockResolvedValue({ items: [OPEN], total: 1, page: 1, pageSize: 20 });
    mocks.get.mockResolvedValue(DETAIL);
    mocks.create.mockResolvedValue({ ...DETAIL, id: 't2', replies: [] });
    mocks.reply.mockResolvedValue({ ...DETAIL, status: 'OPEN' });
  });

  it('技术支持页列出我的技术支持工单', async () => {
    renderPage('SUPPORT');
    expect(await screen.findByRole('heading', { name: '技术支持' })).toBeInTheDocument();
    expect(await screen.findByText('报告导不出来')).toBeInTheDocument();
    expect(screen.getByText('已回复')).toBeInTheDocument();
    expect(mocks.mine).toHaveBeenCalledWith(expect.objectContaining({ kind: 'SUPPORT', page: 1 }));
  });

  it('意见反馈页按反馈类型查询，提交的也是反馈', async () => {
    mocks.mine.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderPage('FEEDBACK');
    expect(await screen.findByRole('heading', { name: '意见反馈' })).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.mine).toHaveBeenCalledWith(expect.objectContaining({ kind: 'FEEDBACK' })),
    );
    await userEvent.click(screen.getByRole('button', { name: '提交反馈' }));
    const dialog = await screen.findByRole('dialog', { name: '提交反馈' });
    await userEvent.type(within(dialog).getByLabelText(/标题/), '希望支持暗色模式');
    await userEvent.type(within(dialog).getByLabelText(/内容/), '晚上看着刺眼');
    await userEvent.click(within(dialog).getByRole('button', { name: '提交' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        kind: 'FEEDBACK',
        title: '希望支持暗色模式',
        content: '晚上看着刺眼',
      }),
    );
  });

  it('打开详情看到原文和回复，可以追加回复', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '报告导不出来' }));
    const dialog = await screen.findByRole('dialog', { name: '报告导不出来' });
    expect(within(dialog).getByText('点导出没反应')).toBeInTheDocument();
    expect(within(dialog).getByText('请升级到最新版本')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('回复'), '升级后好了');
    await userEvent.click(within(dialog).getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledWith('t1', '升级后好了'));
    expect(within(dialog).queryByRole('button', { name: '关闭工单' })).not.toBeInTheDocument();
  });

  it('已关闭的工单不能再回复', async () => {
    mocks.get.mockResolvedValue({ ...DETAIL, status: 'CLOSED' });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '报告导不出来' }));
    const dialog = await screen.findByRole('dialog', { name: '报告导不出来' });
    await within(dialog).findByText('点导出没反应');
    expect(within(dialog).queryByLabelText('回复')).not.toBeInTheDocument();
  });
});
