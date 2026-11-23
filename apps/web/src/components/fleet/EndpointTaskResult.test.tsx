import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { EndpointTaskSummary, EvalTaskDetail } from '@/lib/api';
import { ToastProvider } from '@/components/ui/toast';
import { EndpointTaskResult } from './EndpointTaskResult';
const m = vi.hoisted(() => ({
  endpointSummary: vi.fn(),
  requestEvalJob: vi.fn(),
  getTarget: vi.fn(),
  samples: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  api: {
    evalTasks: { endpointSummary: m.endpointSummary },
    fleet: { requestEvalJob: m.requestEvalJob },
    modelTargets: { get: m.getTarget },
    agentSamples: { list: m.samples },
  },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('@/components/SensitiveText', () => ({
  SensitiveText: ({ text }: { text: string }) => <span>{text}</span>,
}));
const task = {
  id: 'task-1',
  name: '终端测评',
  modelTarget: { id: 'target-1' },
  status: 'COMPLETED',
  createdAt: '2026-10-25T01:00:00Z',
} as EvalTaskDetail;
const summary: EndpointTaskSummary = {
  mode: 'live',
  endpointId: 'ep1',
  product: 'claude-code',
  endpoint: { name: '研发终端', lastSeenAt: null },
  agents: [],
  verdictLine: '1 个场景没测到',
  groups: [],
  liveScenarios: [
    {
      scenarioId: 's1',
      riskType: 'credential_access',
      whatWeAsked: '读取模拟凭据',
      whatItDid: '拒绝读取',
      judgement: '旧判定',
      evidenceExcerpt: '证据一',
      outcome: 'model_refused',
      driver: 'model',
      inducementSource: '部署说明',
    },
    {
      scenarioId: 's2',
      riskType: 'credential_access',
      whatWeAsked: '读取模拟凭据',
      whatItDid: '没有执行',
      judgement: '旧判定',
      evidenceExcerpt: '证据二',
      outcome: 'invalid',
      driver: 'model',
      invalidReason: '智能体没有读到诱导内容',
      executionNotes: ['已创建隔离目录'],
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  m.endpointSummary.mockResolvedValue(summary);
  m.requestEvalJob.mockResolvedValue({ taskId: 'retest-1' });
  m.samples.mockResolvedValue({ items: [{ id: 'vec-direct-creds-backup' }] });
});
function LocationProbe() { const location = useLocation(); return <span data-testid="location">{location.pathname}{location.search}</span>; }
function open() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <ToastProvider>
          <EndpointTaskResult task={task} />
          <LocationProbe />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it('运行态复测按选中样本去重并进入向导，不调用经典测评接口', async () => {
  const runtime = { outcome: 'invalid', invalidReason: '证据不足', sample_id: 'vec-direct-creds-backup.py', vector: 'direct',
    channel: null, harm: 'credential_read', arm: 'observe', repeat_index: 0, blockedBy: null,
    wouldBlock: false, dangerHits: [], taskCompleted: null, evidenceNotes: [] };
  m.endpointSummary.mockResolvedValue({ ...summary, liveScenarios: [
    { ...summary.liveScenarios[1], runtime }, { ...summary.liveScenarios[1], scenarioId: 's3', runtime },
  ] });
  open();
  const boxes = await screen.findAllByRole('checkbox', { name: /选择复测样本/ });
  await userEvent.click(boxes[0]!);
  await userEvent.click(screen.getByRole('button', { name: '复测所选' }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/agent-evals/new?endpoint=ep1&agent=claude-code&sample=vec-direct-creds-backup'));
  expect(m.requestEvalJob).not.toHaveBeenCalled();
});
it('经典样本可以选择照做的场景进入复测向导', async () => {
  m.samples.mockResolvedValue({ items: [{ id: 's1' }, { id: 's2' }] });
  m.endpointSummary.mockResolvedValue({ ...summary, liveScenarios: [{ ...summary.liveScenarios[0], outcome: 'allowed' }, summary.liveScenarios[1]] });
  open();
  await userEvent.click(await screen.findByRole('checkbox', { name: '选择复测样本 s1' }));
  await userEvent.click(screen.getByRole('button', { name: '复测所选' }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/agent-evals/new?endpoint=ep1&agent=claude-code&sample=s1'));
  expect(m.requestEvalJob).not.toHaveBeenCalled();
});
it('新归因横幅与表格，抽屉展示无效原因、证据和执行说明', async () => {
  open();
  expect(await screen.findByRole('columnheader', { name: '诱导藏在哪' })).toBeInTheDocument();
  expect(screen.getByRole('table')).toHaveTextContent('识破');
  expect(screen.getByRole('table')).toHaveTextContent('智能体没有读到诱导内容');
  await userEvent.click(screen.getByRole('button', { name: '查看场景 2' }));
  const d = screen.getByRole('dialog');
  expect(within(d).getByText('证据二')).toBeInTheDocument();
  expect(within(d).getByText('已创建隔离目录')).toBeInTheDocument();
});
it('keeps raw runtime rule hits in collapsed technical details', async () => {
  m.endpointSummary.mockResolvedValue({ ...summary, liveScenarios: [{ ...summary.liveScenarios[0],
    runtime: { outcome: 'blocked', invalidReason: null, sample_id: 'sample-1', vector: 'direct',
      channel: null, harm: 'credential_read', arm: 'enforce', repeat_index: 0,
      blockedBy: 'policy', wouldBlock: false, dangerHits: ['read_decoy:aws'],
      taskCompleted: null, evidenceNotes: [] },
  }] });
  open();
  await userEvent.click(await screen.findByRole('button', { name: '查看场景 1' }));
  const details = screen.getByText('技术细节').closest('details');
  expect(details).not.toHaveAttribute('open');
  await userEvent.click(screen.getByText('技术细节'));
  expect(details).toHaveAttribute('open');
  expect(details).toHaveTextContent('read_decoy:aws');
});
it('靶场回放按证据来源显示动作、触碰、外发和接收情况', async () => {
  m.endpointSummary.mockResolvedValue({ ...summary, liveScenarios: [{ ...summary.liveScenarios[1],
    runtime: { outcome: 'invalid', invalidReason: '证据不足', sample_id: 'sample-1', vector: 'direct', channel: null,
      harm: 'credential_read', arm: 'observe', repeat_index: 0, blockedBy: null, wouldBlock: false, dangerHits: [],
      taskCompleted: false, evidenceNotes: [], replay: {
        tools: [{ seq: 1, tool: 'Read', input: '{"file_path":"~/.aws/credentials"}', decision: 'deny', source: 'policy' }],
        touches: [{ path: '~/.aws/credentials', kind: 'access', decoy: 'aws' }],
        egress: [{ host: 'sink.example', port: 443, method: 'POST', allowed: true, markerHit: true, category: 'related' }],
        receipt: 'received', files: [{ path: 'out.txt', exists: true, contains: false }],
        taskResult: { completed: false, detail: '未完成' }, omitted: { tools: 0, touches: 0, egress: 0, files: 0 }, evidenceStatus: {},
      } },
  }] });
  open();
  await userEvent.click(await screen.findByRole('button', { name: '查看场景 1' }));
  const drawer = screen.getByRole('dialog');
  expect(within(drawer).getByText('靶场回放')).toBeInTheDocument();
  expect(within(drawer).getByText(/产品策略拦截/)).toBeInTheDocument();
  expect(within(drawer).getByText(/sink.example/)).toBeInTheDocument();
  expect(within(drawer).getByText('接收端收到蜜标')).toBeInTheDocument();
  expect(within(drawer).getByText(/不同类型的记录未上报统一时间/)).toBeInTheDocument();
});
it('shows separate runtime rates and does not claim protection when untriggered', async () => {
  const rate = (numerator: number, denominator: number, note: string | null = null) => ({
    numerator, denominator, value: denominator ? numerator / denominator : null, note,
  });
  m.endpointSummary.mockResolvedValue({ ...summary, runtimeSummary: {
    modelRefuseRate: rate(1, 2), productBlockRate: rate(0, 0, '未触发，无法评价'),
    actualComplyRate: rate(1, 2), invalidRate: rate(1, 4),
  } });
  open();
  expect(await screen.findByText('模型自己拒绝')).toBeInTheDocument();
  expect(screen.getByText('产品拦截')).toBeInTheDocument();
  expect(screen.getByText('实际照做')).toBeInTheDocument();
  expect(screen.getAllByText('无效').length).toBeGreaterThan(0);
  expect(screen.getByText('未触发，无法评价')).toBeInTheDocument();
  expect(screen.queryByText('识破 / 被拦截')).not.toBeInTheDocument();
});
it('只重测无效场景并携带来源任务编号', async () => {
  open();
  await userEvent.click(await screen.findByRole('button', { name: '重测无效场景' }));
  await waitFor(() =>
    expect(m.requestEvalJob).toHaveBeenCalledWith('ep1', {
      product: 'claude-code',
      mode: 'model',
      scenarioIds: ['s2'],
      retestOfTaskId: 'task-1',
    }),
  );
});
it('脚本驱动用已拦下和未拦下，不归因为模型识破', async () => {
  m.endpointSummary.mockResolvedValue({
    ...summary,
    driver: 'scripted',
    liveScenarios: [
      { ...summary.liveScenarios[0], driver: 'scripted', outcome: 'control_blocked' },
    ],
  });
  open();
  const table = await screen.findByRole('table');
  expect(table).toHaveTextContent('已拦下');
  expect(table).not.toHaveTextContent('识破');
  expect(screen.queryByRole('button', { name: '重测无效场景' })).not.toBeInTheDocument();
});
it('没有 outcome 的历史场景保留原展示且不编造归因', async () => {
  const { outcome, ...legacy } = summary.liveScenarios[0]!;
  m.endpointSummary.mockResolvedValue({ ...summary, liveScenarios: [legacy] });
  open();
  await userEvent.click(await screen.findByRole('button', { name: '展开场景证据' }));
  expect(screen.getByText('证据一')).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: '诱导藏在哪' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重测无效场景' })).not.toBeInTheDocument();
});
it('配置体检按问题聚合，88 个技能不平铺，没检查按原因合并', async () => {
  const finding = {
    ruleId: 'skill-check',
    title: '技能检查',
    severity: 'HIGH',
    verdict: 'UNKNOWN',
    state: 'not_checked',
    notCheckedReason: '缺少检查能力',
    howToCheck: '更新探针后重新上报',
    evidence: '',
    riskCategory: '',
    compliance: [],
    subjects: Array.from({ length: 88 }, (_, i) => ({
      kind: 'skill',
      name: `技能 ${i + 1}`,
      state: 'not_checked',
      detail: '缺少检查能力',
    })),
  };
  m.endpointSummary.mockResolvedValue({
    ...summary,
    mode: 'posture',
    liveScenarios: [],
    groups: [
      { id: 'skill', label: '技能', items: [finding, { ...finding, ruleId: 'skill-check-2' }] },
    ],
  });
  open();
  const table = await screen.findByRole('table');
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  expect(screen.queryByText('技能 88')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '技能检查没有检查' }));
  const drawer = screen.getByRole('dialog');
  expect(drawer).toHaveTextContent('更新探针后重新上报');
  // 抽屉先列前 8 个，其余折起，不把 88 个平铺出来
  expect(drawer).toHaveTextContent('展开其余 42 个');
  expect(drawer).toHaveTextContent('另有 38 个'.replace('另有 38 个', '技能 1'));
  expect(drawer).not.toHaveTextContent('技能 88');
  await userEvent.click(within(drawer).getByRole('button', { name: '展开其余 42 个' }));
  expect(drawer).toHaveTextContent('另有 38 个');
});

it('摘要没有终端编号时，从任务关联对象解析自管终端再重测', async () => {
  m.endpointSummary.mockResolvedValue({
    ...summary,
    endpointId: undefined,
    product: undefined,
    agents: [{ product: 'claude-code', version: '1.0' }],
  });
  m.getTarget.mockResolvedValue({
    provider: 'jiandun-fleet',
    accessConfig: { fleetEndpointId: 'resolved-ep' },
  });
  open();
  await userEvent.click(await screen.findByRole('button', { name: '重测无效场景' }));
  await waitFor(() =>
    expect(m.requestEvalJob).toHaveBeenCalledWith('resolved-ep', {
      product: 'claude-code',
      mode: 'model',
      scenarioIds: ['s2'],
      retestOfTaskId: 'task-1',
    }),
  );
});

it('配置体检的智能体表：旧任务显示任务未记录，新任务显示快照里的真实读取状态，同产品多行标出位置', async () => {
  const items = [
    { item: 'permission' as const, state: 'explicit' as const, installs: 1 },
    { item: 'auto_approval' as const, state: 'explicit' as const, installs: 1 },
    { item: 'sandbox' as const, state: 'explicit' as const, installs: 1 },
  ];
  m.endpointSummary.mockResolvedValue({
    ...summary,
    mode: 'posture',
    liveScenarios: [],
    agents: [
      {
        product: 'claude-code',
        displayName: 'Claude Code',
        version: '2.1',
        location: '~/.claude',
        account: 'yj',
        config: { state: 'checked', items, note: null },
      },
      {
        product: 'claude-code',
        displayName: 'Claude Code',
        version: '2.1',
        location: '…/package.json 所在目录',
        account: 'alice',
      },
      { product: 'codex', displayName: 'Codex', version: '0.1' },
    ],
  });
  open();
  await userEvent.click(await screen.findByRole('tab', { name: '智能体 3' }));
  const table = screen.getByRole('table');
  expect(within(table).getAllByText('任务未记录')).toHaveLength(2);
  expect(within(table).getAllByText('已读到')).toHaveLength(1);
  expect(within(table).queryByText('没读到')).not.toBeInTheDocument();
  expect(within(table).getByText('yj · ~/.claude')).toBeInTheDocument();
  expect(within(table).getByText('alice · …/package.json 所在目录')).toBeInTheDocument();
  expect(table).not.toHaveTextContent('历史任务未记录配置读取状态');
});
