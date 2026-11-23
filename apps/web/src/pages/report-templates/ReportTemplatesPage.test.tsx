import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import type { ReportTemplate } from '@/lib/api';
import { REPORT_SECTION_LABELS, REPORT_SECTIONS } from '@/lib/format';
import { ReportTemplatesPage } from './ReportTemplatesPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setDefault: vi.fn(),
  perms: new Set<string>(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      reportTemplates: {
        list: mocks.list,
        create: mocks.create,
        update: mocks.update,
        remove: mocks.remove,
        setDefault: mocks.setDefault,
      },
    },
  };
});
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => mocks.perms.has(code) }),
}));

const TEMPLATE: ReportTemplate = {
  id: 'tpl-1',
  name: '客户交付模板',
  sections: [],
  evidenceDetail: 'summary',
  coverTitle: '',
  coverKicker: '',
  organization: '某检测中心',
  client: '',
  classification: '秘密',
  headerText: '',
  footerText: '',
  isDefault: true,
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <ReportTemplatesPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ReportTemplatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ items: [TEMPLATE] });
    mocks.create.mockResolvedValue({ ...TEMPLATE, id: 'tpl-2', isDefault: false });
  });

  it('没有 report_template:manage 时只能看，没有新建、编辑按钮', async () => {
    mocks.perms = new Set(['report:read']);
    renderPage();
    const row = (await screen.findByText('客户交付模板')).closest('tr')!;
    expect(within(row).getByText('默认')).toBeInTheDocument();
    expect(within(row).getByText('秘密')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新建模板' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });

  it('新建模板：提交的章节是勾选的那些，按固定顺序', async () => {
    const user = userEvent.setup();
    mocks.perms = new Set(['report:read', 'report_template:manage']);
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建模板' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^名称/), '领导简报');
    // 默认全选，去掉红队实录和附录
    for (const key of ['redTeam', 'appendix'] as const) {
      await user.click(within(dialog).getByRole('checkbox', { name: REPORT_SECTION_LABELS[key] }));
    }
    await user.selectOptions(within(dialog).getByLabelText('证据详略'), '不附对话过程');
    await user.type(within(dialog).getByLabelText('检测单位'), '某检测中心');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const body = mocks.create.mock.calls[0]![0];
    expect(body.sections).toEqual(
      REPORT_SECTIONS.filter((s) => s !== 'redTeam' && s !== 'appendix'),
    );
    expect(body).toMatchObject({
      name: '领导简报',
      evidenceDetail: 'none',
      organization: '某检测中心',
      classification: '内部使用',
      isDefault: false,
    });
  });

  it('章节全选时提交空数组（不限定章节）', async () => {
    const user = userEvent.setup();
    mocks.perms = new Set(['report:read', 'report_template:manage']);
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建模板' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^名称/), '全部章节');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]![0].sections).toEqual([]);
  });

  it('章节全部取消时不能保存', async () => {
    const user = userEvent.setup();
    mocks.perms = new Set(['report:read', 'report_template:manage']);
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建模板' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^名称/), '空模板');
    for (const key of REPORT_SECTIONS) {
      await user.click(within(dialog).getByRole('checkbox', { name: REPORT_SECTION_LABELS[key] }));
    }
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeDisabled();
  });
});
