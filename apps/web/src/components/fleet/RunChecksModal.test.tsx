import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { MOCK_ENDPOINTS } from '@/pages/fleet/__mocks__/data';
import { CHECK_CATALOG } from './check-catalog.test-data';
import { RunChecksModal } from './RunChecksModal';
import { RiskSummary } from './RiskSummary';
import { overviewFixture } from './endpoint-overview.test-data';

const m = vi.hoisted(() => ({
  checkCatalog: vi.fn(),
  endpoint: vi.fn(),
  overview: vi.fn(),
  postureEval: vi.fn(),
  requestEvalJob: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: { fleet: m } }));
beforeEach(() => {
  vi.clearAllMocks();
  m.checkCatalog.mockResolvedValue(CHECK_CATALOG);
  m.endpoint.mockResolvedValue(undefined);
  m.overview.mockResolvedValue({ ...overviewFixture, agents: [overviewFixture.agents[0]] });
  m.postureEval.mockResolvedValue({ taskId: 't1' });
  m.requestEvalJob.mockResolvedValue({});
});
function open(registered = true) {
  if (!registered)
    m.overview.mockResolvedValue({
      ...overviewFixture,
      agents: [
        {
          ...overviewFixture.agents[0],
          liveEval: {
            supported: true,
            registered: false,
            reason: '尚未上报智能体登记信息，请联系终端管理员',
          },
        },
      ],
    });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <ToastProvider>
          <RunChecksModal
            endpoint={{
              ...MOCK_ENDPOINTS[0]!,
              agents: MOCK_ENDPOINTS[0]!.agents.map((a) => ({
                ...a,
                ...(registered ? { liveEvalRegistered: true, liveEvalSupported: true } : {}),
              })),
            }}
            onClose={() => {}}
          />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it('模式卡片与紧凑药丸展示，配置默认全选，真机默认不选', async () => {
  open();
  await userEvent.click(await screen.findByRole('button', { name: '调整' }));
  expect(screen.getByLabelText('权限检查')).toBeChecked();
  expect(screen.getByLabelText('启用真机测评')).not.toBeChecked();
  expect(screen.getByLabelText('配置体检')).toBeChecked();
  expect(screen.getByText('只读 · 立即出结果')).toBeInTheDocument();
  expect(screen.getByText(/依据 .* 的最近一次上报/)).toBeInTheDocument();
  expect(screen.queryByText('运行检查')).not.toBeInTheDocument();
});
it('未登记智能体显示原因且无法选中，默认选中全部已登记产品', async () => {
  m.overview.mockResolvedValue(overviewFixture);
  open();
  await screen.findByRole('button', { name: '调整' });
  await userEvent.click(screen.getByLabelText('启用真机测评'));
  const unavailable = screen.getByRole('checkbox', { name: 'OpenClaw' });
  expect(unavailable).toBeDisabled();
  await userEvent.click(unavailable);
  expect(unavailable).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Claude Code' })).toBeChecked();
  expect(unavailable.closest('label')).toHaveAttribute('title', '尚未登记，请联系终端管理员');
});
it('只选配置调用配置接口并提供进度链接', async () => {
  open();
  await screen.findByRole('button', { name: '调整' });
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await waitFor(() =>
    expect(m.postureEval).toHaveBeenCalledWith('ep1', { items: ['permissions'] }),
  );
  expect(m.requestEvalJob).not.toHaveBeenCalled();
  expect(await screen.findByRole('link', { name: '去看进度' })).toHaveAttribute(
    'href',
    '/eval-tasks/t1',
  );
});
it('真机必须额外确认，两个模式都选时分别提交', async () => {
  open();
  await screen.findByRole('button', { name: '调整' });
  await userEvent.click(screen.getByLabelText('启用真机测评'));
  expect(screen.getByRole('button', { name: '开始检测' })).toBeDisabled();
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await waitFor(() =>
    expect(m.requestEvalJob).toHaveBeenCalledWith('ep1', {
      product: 'claude-code',
      riskTypes: ['credential_access'],
    }),
  );
  expect(m.postureEval).toHaveBeenCalledWith('ep1', { items: ['permissions'] });
});
it('风险按类别计数并显示未知提示与整改建议', () => {
  render(
    <RiskSummary
      catalog={CHECK_CATALOG}
      findings={[
        {
          ruleId: 'permissions',
          title: '权限检查',
          severity: 'HIGH',
          verdict: 'FAIL',
          evidence: '授权范围过大',
          riskCategory: '',
          compliance: [],
        },
        {
          ruleId: 'missing',
          title: '未采集项目',
          severity: 'LOW',
          verdict: 'UNKNOWN',
          evidence: '',
          riskCategory: '',
          compliance: [],
        },
      ]}
    />,
  );
  expect(screen.getByText('这台电脑上发现 1 类风险，其中 1 类高危')).toBeInTheDocument();
  expect(screen.getByText('命中 1 / 1 项')).toBeInTheDocument();
  expect(
    screen.getByText('另有 1 项终端没有检查，原因和办法见下。不同检查项可能涉及同一个对象。'),
  ).toBeInTheDocument();
  expect(screen.getByText('缩小授权范围')).toBeInTheDocument();
  expect(screen.getByText('终端没有提供完成这一项检查所需的信息。')).toBeInTheDocument();
  expect(screen.queryByText('本次采集范围内未发现风险')).not.toBeInTheDocument();
});
it('没有结果提示开始检测，全部通过才显示无风险结论', () => {
  const view = render(<RiskSummary catalog={CHECK_CATALOG} findings={[]} />);
  expect(screen.getByText('还没有检测结果，点「一键检测」开始')).toBeInTheDocument();
  view.rerender(
    <RiskSummary
      catalog={CHECK_CATALOG}
      findings={[
        {
          ruleId: 'permissions',
          title: '权限检查',
          severity: 'HIGH',
          verdict: 'PASS',
          evidence: '',
          riskCategory: '',
          compliance: [],
        },
      ]}
    />,
  );
  expect(screen.getByText('本次采集范围内未发现风险')).toBeInTheDocument();
});
it('取消全部项目不能提交，仅真机选择只调用真机接口', async () => {
  open();
  await userEvent.click(await screen.findByRole('button', { name: '调整' }));
  await userEvent.click(screen.getByLabelText('权限检查'));
  expect(screen.getByRole('button', { name: '开始检测' })).toBeDisabled();
  await userEvent.click(screen.getByLabelText('配置体检'));
  await userEvent.click(screen.getByLabelText('启用真机测评'));
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await waitFor(() => expect(m.requestEvalJob).toHaveBeenCalledTimes(1));
  expect(m.postureEval).not.toHaveBeenCalled();
});
it('真机失败重试不会重复发起已经成功的配置检测', async () => {
  m.requestEvalJob.mockRejectedValueOnce(new Error('暂时无法下发')).mockResolvedValueOnce({});
  open();
  await screen.findByRole('button', { name: '调整' });
  await userEvent.click(screen.getByLabelText('启用真机测评'));
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await screen.findByText('暂时无法下发');
  expect(screen.getByRole('link', { name: '去看进度' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await waitFor(() => expect(m.requestEvalJob).toHaveBeenCalledTimes(2));
  expect(m.postureEval).toHaveBeenCalledTimes(1);
});
it('目录失败不能提交并允许重新加载', async () => {
  m.checkCatalog.mockRejectedValueOnce(new Error('暂时无法读取'));
  open();
  expect(await screen.findByRole('alert')).toHaveTextContent('检测项目加载失败');
  expect(screen.getByRole('button', { name: '开始检测' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '重试' }));
  await userEvent.click(await screen.findByRole('button', { name: '调整' }));
  expect(screen.getByLabelText('权限检查')).toBeChecked();
});
it('只有未采集结果不能显示为通过或无风险', () => {
  render(
    <RiskSummary
      catalog={CHECK_CATALOG}
      findings={[
        {
          ruleId: 'permissions',
          title: '权限检查',
          severity: 'HIGH',
          verdict: 'UNKNOWN',
          evidence: '',
          riskCategory: '',
          compliance: [],
        },
      ]}
    />,
  );
  expect(screen.getByText('部分检测项无法判断，暂不能确认安全')).toBeInTheDocument();
  expect(screen.getByText('命中 0 / 1 项')).toBeInTheDocument();
  expect(screen.queryByText('通过')).not.toBeInTheDocument();
});
it('重新勾选真机整组后需要重新确认影响', async () => {
  open();
  await screen.findByRole('button', { name: '调整' });
  await userEvent.click(screen.getByLabelText('启用真机测评'));
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  await userEvent.click(screen.getByLabelText('启用真机测评'));
  await userEvent.click(screen.getByLabelText('启用真机测评'));
  expect(screen.getByLabelText('我已了解以上影响')).not.toBeChecked();
  expect(screen.getByRole('button', { name: '开始检测' })).toBeDisabled();
});
it('多个类别分别统计命中数和最高严重度', () => {
  const item = CHECK_CATALOG.posture[0]!;
  render(
    <RiskSummary
      catalog={{
        ...CHECK_CATALOG,
        posture: [item, { ...item, id: 'second', category: 'behavior' }],
      }}
      findings={[
        {
          ruleId: 'permissions',
          title: '权限检查',
          severity: 'HIGH',
          verdict: 'PASS',
          evidence: '授权范围正常',
          riskCategory: '',
          compliance: [],
        },
        {
          ruleId: 'second',
          title: '行为检查',
          severity: 'MEDIUM',
          verdict: 'FAIL',
          evidence: '缺少确认',
          riskCategory: '',
          compliance: [],
        },
      ]}
    />,
  );
  expect(screen.getByText('这台电脑上发现 1 类风险，其中 0 类高危')).toBeInTheDocument();
  expect(screen.getByText('权限风险')).toBeInTheDocument();
  expect(screen.getByText('行为风险')).toBeInTheDocument();
  expect(screen.getByText('命中 0 / 1 项')).toBeInTheDocument();
  expect(screen.getByText('命中 1 / 1 项')).toBeInTheDocument();
  expect(screen.getByText('中危')).toBeInTheDocument();
});
it('任务下发后清单刷新显示进行中任务，不清空成功反馈', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (blocked?: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <RunChecksModal
            endpoint={{
              ...MOCK_ENDPOINTS[0]!,
              agents: MOCK_ENDPOINTS[0]!.agents.map((a) => ({
                ...a,
                liveEvalRegistered: true,
                liveEvalSupported: true,
              })),
            }}
            onClose={() => {}}
            initialMode="live"
            liveBlockedReason={blocked}
          />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(wrap());
  await screen.findByLabelText('我已了解以上影响');
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await screen.findByRole('link', { name: '去看进度' });
  view.rerender(wrap('该终端已有进行中的任务，请等待任务结束后再试。'));
  expect(screen.getByRole('link', { name: '去看进度' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '开始检测' })).not.toBeInTheDocument();
});

it('没有登记信息时禁止真机测评，显示办理办法', async () => {
  open(false);
  await screen.findByRole('button', { name: '调整' });
  await userEvent.click(screen.getByLabelText('启用真机测评'));
  expect(await screen.findByText(/尚未上报智能体登记信息/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '开始检测' })).toBeDisabled();
});

it('风险摘要如实显示已检查无风险与未检查原因、补查办法', () => {
  render(
    <RiskSummary
      catalog={CHECK_CATALOG}
      findings={[
        {
          ruleId: 'permissions',
          title: '旧标题',
          plainTitle: '权限范围',
          severity: 'LOW',
          verdict: 'PASS',
          state: 'clear',
          evidence: '已读取授权配置',
          riskCategory: '',
          compliance: [],
        },
        {
          ruleId: 'missing',
          title: '缺少依赖',
          severity: 'LOW',
          verdict: 'UNKNOWN',
          state: 'not_checked',
          evidence: '',
          riskCategory: '',
          compliance: [],
          notCheckedReason: '终端无法解析依赖清单',
          howToCheck: '请修复依赖清单后重新检测',
        },
      ]}
    />,
  );
  expect(screen.getByText('权限范围')).toBeInTheDocument();
  expect(screen.getByText('已检查无风险')).toBeInTheDocument();
  expect(screen.getByText('终端没检查')).toBeInTheDocument();
  expect(screen.getByText('终端无法解析依赖清单')).toBeInTheDocument();
  expect(screen.getByText('请修复依赖清单后重新检测')).toBeInTheDocument();
  expect(screen.queryByText('未采集')).not.toBeInTheDocument();
});

it('成功下发后终端详情刷新不能清空反馈或重复提交', async () => {
  const endpoint = {
    ...MOCK_ENDPOINTS[0]!,
    agents: [
      { product: 'claude-code', version: '2.1', liveEvalRegistered: true, liveEvalSupported: true },
    ],
  };
  m.overview.mockResolvedValue({ ...overviewFixture, agents: [overviewFixture.agents[0]] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <RunChecksModal endpoint={endpoint} initialMode="live" onClose={() => {}} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByLabelText('我已了解以上影响');
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await screen.findByRole('link', { name: '去看进度' });
  m.overview.mockResolvedValue({
    ...overviewFixture,
    report: { ...overviewFixture.report!, scannedAt: new Date().toISOString() },
  });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['fleet', 'overview'] });
  });
  await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(3));
  expect(screen.getByRole('link', { name: '去看进度' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '开始检测' })).not.toBeInTheDocument();
  expect(m.requestEvalJob).toHaveBeenCalledTimes(1);
});
it('配置选项真正透传，仅提交保留的项目', async () => {
  m.checkCatalog.mockResolvedValue({
    ...CHECK_CATALOG,
    posture: [
      CHECK_CATALOG.posture[0],
      { ...CHECK_CATALOG.posture[0], id: 'second', title: '凭据检查' },
    ],
  });
  open();
  await userEvent.click(await screen.findByRole('button', { name: '调整' }));
  await userEvent.click(screen.getByLabelText('权限检查'));
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await waitFor(() => expect(m.postureEval).toHaveBeenCalledWith('ep1', { items: ['second'] }));
});
it('多个已登记产品默认全选，部分失败后重试仅下发未成功产品', async () => {
  m.overview.mockResolvedValue({
    ...overviewFixture,
    agents: [
      overviewFixture.agents[0],
      { ...overviewFixture.agents[0], key: 'codex', name: 'Codex' },
    ],
  });
  m.requestEvalJob
    .mockResolvedValueOnce({ taskId: 'live-1' })
    .mockRejectedValueOnce(new Error('第二个暂时失败'))
    .mockResolvedValueOnce({ taskId: 'live-2' });
  open();
  await screen.findByRole('button', { name: '调整' });
  await userEvent.click(screen.getByLabelText('启用真机测评'));
  expect(screen.getByLabelText('Claude Code')).toBeChecked();
  expect(screen.getByLabelText('Codex')).toBeChecked();
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await screen.findByText('第二个暂时失败');
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await waitFor(() => expect(m.requestEvalJob).toHaveBeenCalledTimes(3));
  expect(
    m.requestEvalJob.mock.calls.filter(([, body]) => body.product === 'claude-code'),
  ).toHaveLength(1);
  expect(m.postureEval).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole('link', { name: '测评任务 2' })).toHaveAttribute(
    'href',
    '/eval-tasks/live-2',
  );
});

it('默认收起十项配置，调整与折叠保留选择且不会切换模式', async () => {
  m.checkCatalog.mockResolvedValue({
    ...CHECK_CATALOG,
    posture: Array.from({ length: 10 }, (_, i) => ({
      ...CHECK_CATALOG.posture[0],
      id: 'item-' + i,
      title: '检查项目' + i,
    })),
  });
  open();
  const adjust = await screen.findByRole('button', { name: '调整' });
  expect(screen.getByRole('dialog', { name: '检测 demo-host' })).toBeInTheDocument();
  expect(adjust).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByLabelText('检查项目0')).not.toBeInTheDocument();
  expect(screen.getByText('配置体检 10 项 · 真机测评 0 个场景')).toBeInTheDocument();
  await userEvent.click(adjust);
  for (let i = 0; i < 10; i++) expect(screen.getByLabelText('检查项目' + i)).toBeChecked();
  await userEvent.click(screen.getByLabelText('检查项目0'));
  await userEvent.click(adjust);
  expect(screen.queryByLabelText('检查项目0')).not.toBeInTheDocument();
  expect(screen.getByLabelText('配置体检')).toBeChecked();
  await userEvent.click(adjust);
  expect(screen.getByLabelText('检查项目0')).not.toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await waitFor(() =>
    expect(m.postureEval).toHaveBeenCalledWith('ep1', {
      items: Array.from({ length: 9 }, (_, i) => 'item-' + (i + 1)),
    }),
  );
});
it('真机黄条只显示首句，说明保留完整影响，关闭真机隐藏确认条', async () => {
  m.checkCatalog.mockResolvedValue({
    ...CHECK_CATALOG,
    liveSummary: {
      ...CHECK_CATALOG.liveSummary,
      consumesQuota: '使用真实配置和模型额度。额度无法退回。',
    },
  });
  open();
  await screen.findByRole('button', { name: '调整' });
  await userEvent.click(screen.getByLabelText('启用真机测评'));
  expect(screen.getByText('使用真实配置和模型额度。')).toBeVisible();
  expect(screen.queryByText(CHECK_CATALOG.liveSummary.cleanup)).not.toBeInTheDocument();
  expect(screen.queryByText(CHECK_CATALOG.liveSummary.isolationNote)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '说明' })).toHaveAttribute(
    'title',
    expect.stringContaining(CHECK_CATALOG.liveSummary.cleanup),
  );
  expect(screen.getByRole('button', { name: '说明' })).toHaveAttribute(
    'title',
    expect.stringContaining(CHECK_CATALOG.liveSummary.isolationNote),
  );
  expect(screen.getByRole('button', { name: '开始检测' })).toBeDisabled();
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  expect(screen.getByRole('button', { name: '开始检测' })).toBeEnabled();
  await userEvent.click(screen.getByLabelText('启用真机测评'));
  expect(screen.queryByText('使用真实配置和模型额度。')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('我已了解以上影响')).not.toBeInTheDocument();
});
