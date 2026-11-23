import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { MOCK_ENDPOINTS } from '@/pages/fleet/__mocks__/data';
import { CHECK_CATALOG } from './check-catalog.test-data';
import { RunChecksModal } from './RunChecksModal';
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
  m.overview.mockResolvedValue({ ...overviewFixture, agents: [overviewFixture.agents[0]] });
  m.postureEval.mockResolvedValue({ taskId: 't1' });
  m.requestEvalJob.mockResolvedValue({});
});

/** runtimeV2：true/false 为终端清单里 claude-code 的上报值；'absent' 表示旧后端没有该字段。 */
function open(runtimeV2: boolean | 'absent' = true) {
  const agent = {
    product: 'claude-code',
    version: '2.1.0',
    liveEvalRegistered: true,
    liveEvalSupported: true,
  };
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <ToastProvider>
          <RunChecksModal
            endpoint={{
              ...MOCK_ENDPOINTS[0]!,
              agents: [runtimeV2 === 'absent' ? agent : { ...agent, runtimeV2 }],
            }}
            onClose={() => {}}
            initialMode="live"
          />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const suiteButton = (name: string) => screen.getByRole('button', { name });
async function chooseRuntime() {
  await screen.findByLabelText('我已了解以上影响');
  await userEvent.click(suiteButton('运行态测评'));
}
const start = () => userEvent.click(screen.getByRole('button', { name: '开始检测' }));

it('终端没上报运行态能力时灰显并写明原因，旧后端缺字段与明确为假都一样', async () => {
  open('absent');
  await screen.findByLabelText('我已了解以上影响');
  expect(suiteButton('运行态测评')).toBeDisabled();
  expect(suiteButton('运行态测评')).toHaveAttribute(
    'title',
    '终端的测评执行器版本过旧，请升级探针',
  );
  expect(screen.getByText('终端的测评执行器版本过旧，请升级探针')).toBeInTheDocument();
  expect(suiteButton('经典 12 场景')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('group', { name: '测评套件' })).toBeInTheDocument();
  expect(screen.queryByLabelText('防护臂')).not.toBeInTheDocument();
});

it('runtimeV2 明确为 false 时同样灰显', async () => {
  open(false);
  await screen.findByLabelText('我已了解以上影响');
  expect(suiteButton('运行态测评')).toBeDisabled();
});

it('取消勾选 Claude Code 后运行态不可选，并提示只支持 Claude Code', async () => {
  open();
  await screen.findByLabelText('我已了解以上影响');
  await userEvent.click(screen.getByLabelText('Claude Code'));
  expect(suiteButton('运行态测评')).toBeDisabled();
  expect(screen.getByText(/运行态测评目前只支持 Claude Code/)).toBeInTheDocument();
});

it('选择运行态后展示档位、类别、防护臂、模板、重复次数，缺省为标准档', async () => {
  open();
  await chooseRuntime();
  expect(screen.getByLabelText('标准')).toBeChecked();
  expect(
    screen.getByText(/每类最多 5 个样本，每个重复 2 次，防护关\/开各一组/),
  ).toBeInTheDocument();
  for (const v of [
    '直接请求',
    '间接注入',
    '工具描述投毒',
    '记忆和配置文件投毒',
    '多步拆分攻击',
    '任务诱导的过度操作',
  ])
    expect(screen.getByLabelText(v)).toBeChecked();
  expect(screen.getByLabelText('防护关')).toBeChecked();
  expect(screen.getByLabelText('防护开')).toBeChecked();
  expect(screen.getByText('只观察不拦截，用来看智能体自己会不会做')).toBeInTheDocument();
  expect(screen.getByText('启用终端本地策略拦截，用来看防护能拦住什么')).toBeInTheDocument();
  expect(screen.getByLabelText('Python 库存服务')).toBeChecked();
  expect(screen.getByLabelText('Node 订单接口')).not.toBeChecked();
  expect(screen.getByLabelText('重复次数')).toHaveValue('2');
  expect(screen.getByText(/标准档约 60 到 120 个场景，约 3 到 5.5 小时/)).toBeInTheDocument();
  expect(screen.getByText(/沙箱内没有外网，只放行模型出口/)).toBeInTheDocument();
  expect(screen.queryByLabelText('凭据读取')).not.toBeInTheDocument();
});

it('快速档缺省只选防护关、重复 1 次；完整档缺省两个模板', async () => {
  open();
  await chooseRuntime();
  await userEvent.click(screen.getByLabelText('快速'));
  expect(screen.getByLabelText('防护关')).toBeChecked();
  expect(screen.getByLabelText('防护开')).not.toBeChecked();
  expect(screen.getByLabelText('重复次数')).toHaveValue('1');
  await userEvent.click(screen.getByLabelText('完整'));
  expect(screen.getByLabelText('防护开')).toBeChecked();
  expect(screen.getByLabelText('Python 库存服务')).toBeChecked();
  expect(screen.getByLabelText('Node 订单接口')).toBeChecked();
  expect(screen.getByLabelText('重复次数')).toHaveValue('3');
});

it('一个防护臂都不选时提交按钮禁用并提示', async () => {
  open();
  await chooseRuntime();
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  await userEvent.click(screen.getByLabelText('我了解防护开只验证终端本地策略'));
  expect(screen.getByRole('button', { name: '开始检测' })).toBeEnabled();
  await userEvent.click(screen.getByLabelText('防护关'));
  await userEvent.click(screen.getByLabelText('防护开'));
  expect(screen.getByText('请至少选择一个防护臂')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '开始检测' })).toBeDisabled();
  await userEvent.click(screen.getByLabelText('防护开'));
  // 改动任何选项都会清掉“我已了解以上影响”（与风险类型、智能体的既有行为一致），需重新确认。
  expect(screen.getByRole('button', { name: '开始检测' })).toBeDisabled();
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  expect(screen.getByRole('button', { name: '开始检测' })).toBeEnabled();
});

it('必须额外确认防护开只验证终端本地策略才能提交', async () => {
  open();
  await chooseRuntime();
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  expect(screen.getByRole('button', { name: '开始检测' })).toBeDisabled();
  await userEvent.click(screen.getByLabelText('我了解防护开只验证终端本地策略'));
  expect(screen.getByRole('button', { name: '开始检测' })).toBeEnabled();
});

it('提交的请求体含套件与全部运行态选项，成功提示显示实际场景数和预计耗时', async () => {
  m.requestEvalJob.mockResolvedValue({ taskId: 'rt-1', scenarioCount: 90, estimate_seconds: 6300 });
  open();
  await chooseRuntime();
  await userEvent.click(screen.getByLabelText('间接注入'));
  await userEvent.click(screen.getByLabelText('Node 订单接口'));
  await userEvent.selectOptions(screen.getByLabelText('重复次数'), '3');
  await userEvent.type(screen.getByLabelText('备注'), '  复测  ');
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  await userEvent.click(screen.getByLabelText('我了解防护开只验证终端本地策略'));
  await start();
  await waitFor(() => expect(m.requestEvalJob).toHaveBeenCalledTimes(1));
  expect(m.requestEvalJob).toHaveBeenCalledWith('ep1', {
    product: 'claude-code',
    suite: 'runtime_v2',
    tier: 'standard',
    vectors: ['direct', 'tool_poison', 'memory_config', 'multi_step', 'overreach'],
    arms: ['observe', 'enforce'],
    repeat: 3,
    templates: ['py-service-v1', 'node-api-v1'],
    reason: '复测',
  });
  const status = await screen.findByRole('status');
  expect(within(status).getByText(/共 90 个场景，预计约 1\.8 小时/)).toBeInTheDocument();
  expect(within(status).getByRole('link', { name: '去看进度' })).toHaveAttribute(
    'href',
    '/eval-tasks/rt-1',
  );
});

it('经典套件的请求体与改动前一致，不带运行态字段', async () => {
  open();
  await screen.findByLabelText('我已了解以上影响');
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  await start();
  await waitFor(() =>
    expect(m.requestEvalJob).toHaveBeenCalledWith('ep1', {
      product: 'claude-code',
      riskTypes: ['credential_access'],
    }),
  );
});

it('409 能力缺失给中文提示，其余后端错误原样显示', async () => {
  const unsupported = Object.assign(new Error('Conflict'), {
    code: 'FLEET_SANDBOX_V2_UNSUPPORTED',
  });
  m.requestEvalJob
    .mockRejectedValueOnce(unsupported)
    .mockRejectedValueOnce(new Error('场景数 360 超过上限 240，请缩小范围：减少攻击类别'));
  open();
  await chooseRuntime();
  await userEvent.click(screen.getByLabelText('我已了解以上影响'));
  await userEvent.click(screen.getByLabelText('我了解防护开只验证终端本地策略'));
  await start();
  expect(
    await screen.findByText(/终端的测评执行器版本过旧，请升级探针后再发起运行态测评/),
  ).toBeInTheDocument();
  await start();
  expect(
    await screen.findByText('场景数 360 超过上限 240，请缩小范围：减少攻击类别'),
  ).toBeInTheDocument();
});
