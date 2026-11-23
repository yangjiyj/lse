import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { GatesPage, describeGateRules, formToInput } from './GatesPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  targets: vi.fn(),
  plans: vi.fn(),
  perms: ['gate:manage', 'eval_task:read'] as string[],
}));

vi.mock('@/lib/api', () => ({
  api: {
    gates: { list: mocks.list, create: mocks.create, update: mocks.update, remove: mocks.remove },
    modelTargets: { list: mocks.targets },
    evalPlans: { list: mocks.plans },
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (c: string) => mocks.perms.includes(c) }),
}));

const GATE = {
  id: 'g1',
  name: '生产发布门禁',
  planId: null,
  modelTargetId: 'm1',
  modelTargetName: '客服大模型',
  rules: {
    minScore: 80,
    maxHighRisk: 0,
    categoryMaxFailRate: { 隐私泄露: 0.1 },
    noRegression: true,
  },
  enabled: true,
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
  latest: {
    id: 'e1',
    gateId: 'g1',
    taskId: 't1',
    taskName: '夜间回归',
    passed: false,
    reasons: ['总体得分低于门槛'],
    metrics: null,
    previousTaskId: null,
    createdAt: '2026-09-29T01:00:00.000Z',
  },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <GatesPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('GatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = ['gate:manage', 'eval_task:read'];
    mocks.plans.mockResolvedValue({
      items: [{ id: 'p1', name: '夜间回归计划' }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    mocks.list.mockResolvedValue({ items: [GATE] });
    mocks.targets.mockResolvedValue({
      items: [{ id: 'm1', name: '客服大模型' }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
  });

  it('规则摘要与表单转换', () => {
    expect(describeGateRules(GATE.rules)).toBe(
      '总体得分 ≥ 80；高风险数 ≤ 0；隐私泄露失败率 ≤ 10%；相对上次不退化',
    );
    const base = {
      name: 'x',
      modelTargetId: 'm1',
      planId: '',
      minScore: '',
      maxHighRisk: '',
      categories: '',
      noRegression: false,
      enabled: true,
    };
    expect(formToInput(base)).toBe('至少配置一条门禁条件');
    expect(formToInput({ ...base, modelTargetId: '', minScore: '60' })).toBe(
      '请选择评估对象或评估计划',
    );
    expect(formToInput({ ...base, categories: '隐私泄露=abc' })).toMatch(/类别门槛格式错误/);
    expect(formToInput({ ...base, categories: '隐私泄露=12.5', minScore: '70' })).toEqual({
      name: 'x',
      modelTargetId: 'm1',
      planId: null,
      rules: { minScore: 70, categoryMaxFailRate: { 隐私泄露: 0.125 } },
      enabled: true,
    });
  });

  it('列表显示最新判定与未通过理由', async () => {
    renderPage();
    expect(await screen.findByRole('cell', { name: '生产发布门禁' })).toBeInTheDocument();
    expect(screen.getByText('不通过')).toBeInTheDocument();
    expect(screen.getByText('总体得分低于门槛')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '夜间回归' })).toHaveAttribute(
      'href',
      '/eval-tasks/t1',
    );
    expect(screen.getByRole('cell', { name: '评估对象：客服大模型' })).toBeInTheDocument();
  });

  it('新建门禁提交正确入参', async () => {
    mocks.list.mockResolvedValue({ items: [] });
    mocks.create.mockResolvedValue(GATE);
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('暂无数据')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新建门禁' }));
    await user.type(screen.getByLabelText(/门禁名称/), '预发门禁');
    await screen.findByRole('option', { name: '客服大模型' });
    await user.selectOptions(screen.getByLabelText('评估对象'), 'm1');
    await user.type(screen.getByLabelText('高风险数不超过'), '2');
    await user.click(screen.getByLabelText('相对上次运行不退化'));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        name: '预发门禁',
        modelTargetId: 'm1',
        planId: null,
        rules: { maxHighRisk: 2, noRegression: true },
        enabled: true,
      }),
    );
  });

  it('只读用户看不到新建与操作列', async () => {
    mocks.perms = ['gate:read'];
    renderPage();
    await screen.findByRole('cell', { name: '生产发布门禁' });
    expect(screen.queryByRole('button', { name: '新建门禁' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });

  it('评估计划改为下拉选择，提交计划 ID；列表显示计划名称', async () => {
    mocks.list.mockResolvedValue({ items: [{ ...GATE, planId: 'p1', modelTargetId: null }] });
    mocks.create.mockResolvedValue(GATE);
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('cell', { name: '评估计划：夜间回归计划' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新建门禁' }));
    await user.type(screen.getByLabelText(/门禁名称/), '计划门禁');
    const planSelect = screen.getByRole('combobox', { name: '评估计划' });
    await within(planSelect).findByRole('option', { name: '夜间回归计划' });
    await user.selectOptions(planSelect, 'p1');
    await user.type(screen.getByLabelText('总体得分不低于'), '80');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        name: '计划门禁',
        modelTargetId: null,
        planId: 'p1',
        rules: { minScore: 80 },
        enabled: true,
      }),
    );
  });

  it('编辑时原计划已不存在仍保留原值', async () => {
    mocks.list.mockResolvedValue({ items: [{ ...GATE, planId: 'gone' }] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '编辑' }));
    const planSelect = screen.getByRole('combobox', { name: '评估计划' });
    expect(
      await within(planSelect).findByRole('option', { name: '计划 gone（未找到）' }),
    ).toBeInTheDocument();
    expect(planSelect).toHaveValue('gone');
  });
});
