import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelTarget } from '@/lib/api';
import { EvaluationPlanSelector } from './EvaluationPlanSelector';

const mocks = vi.hoisted(() => ({ config: vi.fn(), endpoints: vi.fn(), capabilities: vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: {
    modelTargets: { capabilities: mocks.capabilities },
    endpointEvals: { config: mocks.config, endpoints: mocks.endpoints },
  },
}));

/** 终端页的占位：露出地址和查询串，用来断言入口跳到了哪里。 */
function FleetProbe() {
  const { pathname, search } = useLocation();
  return <div>终端页 {pathname + search}</div>;
}

const recent = new Date(Date.now() - 3600_000).toISOString();
const old = new Date(Date.now() - 3 * 86400_000).toISOString();
const MODEL = { id: 'm1', name: '对话模型', targetType: 'MODEL', isActive: true } as ModelTarget;
const ep = (id: string, product: string): ModelTarget =>
  ({
    id,
    name: `对象-${id}`,
    targetType: 'ENDPOINT_AGENT',
    isActive: true,
    accessConfig: { endpointId: id, product, endpointLabel: '标签' },
  }) as unknown as ModelTarget;

function renderSel(targets: ModelTarget[], onSelect = vi.fn()) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={['/eval-tasks']}>
        <Routes>
          <Route
            path="/eval-tasks"
            element={
              <EvaluationPlanSelector
                targets={targets}
                loading={false}
                failed={false}
                retry={() => {}}
                onSelect={onSelect}
              />
            }
          />
          <Route path="/fleet" element={<FleetProbe />} />
          <Route path="/agent-evals/new" element={<div>终端测评向导</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onSelect;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilities.mockResolvedValue({ platformAppEnabled: false });
  mocks.config.mockResolvedValue({ enabled: true, agentshieldBaseUrl: 'https://asp.example' });
  mocks.endpoints.mockResolvedValue([
    {
      endpoint_id: 'a',
      hostname: 'demo-host',
      os: 'linux',
      last_seen_at: recent,
      eval_runner_version: '1',
      agents: [{ product: 'claude-code', headless_capable: true }],
    },
    {
      endpoint_id: 'b',
      hostname: 'YJ40B4',
      os: 'windows',
      last_seen_at: old,
      eval_runner_version: null,
      agents: [{ product: 'codex', headless_capable: true }],
    },
  ]);
});

describe('方案选择：终端智能体', () => {
  it('无需先登记评估对象即可从总入口发起终端智能体测评', async () => {
    renderSel([MODEL]);
    await userEvent.click(screen.getByRole('button', { name: /终端智能体测评/ }));
    expect(screen.getByText(/终端测评向导/)).toBeInTheDocument();
  });
  it('下拉按分组展示，终端对象带产品、主机名与在线状态', async () => {
    renderSel([MODEL, ep('a', 'claude-code'), ep('b', 'codex')]);
    expect(
      await screen.findByRole('option', { name: /Claude Code · demo-host · 在线/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Codex · YJ40B4 · 离线/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '终端智能体' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '模型 API' })).toBeInTheDocument();
  });

  it('选终端后出现体检/运行态测评，其余方案置灰并写明原因', async () => {
    const user = userEvent.setup();
    const onSelect = renderSel([MODEL, ep('a', 'claude-code')]);
    await screen.findByRole('option', { name: /demo-host/ });
    await user.selectOptions(screen.getByLabelText('本次评估对象'), 'a');
    const posture = screen.getByRole('button', { name: /^配置体检/ });
    const run = await screen.findByRole('button', { name: /运行态测评/ });
    expect(posture).toBeEnabled();
    expect(run).toBeEnabled();
    await user.click(posture);
    expect(onSelect).toHaveBeenCalledWith('endpoint-posture', 'a');
    await user.click(run);
    expect(onSelect).toHaveBeenCalledWith('endpoint-run', 'a');
    // 选终端对象后自动落在终端线；切到内容线，其余方案置灰并写明原因。
    expect(screen.getByRole('button', { name: /终端智能体安全/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /大模型内容安全/ }));
    const content = screen.getByRole('button', { name: /题库抽测/ });
    expect(content).toBeDisabled();
    expect(content).toHaveTextContent('终端智能体对象只支持');
    expect(screen.getByRole('button', { name: /多模态越狱/ })).toBeDisabled();
  });

  it('终端不支持运行态测评时仅可体检并说明原因', async () => {
    const user = userEvent.setup();
    renderSel([ep('b', 'codex')]);
    await screen.findByRole('option', { name: /YJ40B4/ });
    await user.selectOptions(screen.getByLabelText('本次评估对象'), 'b');
    const run = await screen.findByRole('button', { name: /运行态测评/ });
    expect(run).toBeDisabled();
    expect(run).toHaveTextContent('不支持运行态测评');
    // 给出路：重新运行安装包 / 一键命令，并说明两种系统的区别
    expect(run).toHaveTextContent('缺少测评执行器');
    expect(run).toHaveTextContent('重新运行安装包或一键命令');
    expect(run).toHaveTextContent('Linux 一键命令已自带开启参数');
    expect(run).toHaveTextContent('Windows 安装包会自动开启');
    expect(screen.getByRole('button', { name: /^配置体检/ })).toBeEnabled();
    expect(screen.getByText(/超过 24 小时未上线/)).toBeInTheDocument();
  });

  it('运行态测评卡片不再提审批，说明下发后由终端自动领取', async () => {
    const user = userEvent.setup();
    renderSel([MODEL, ep('a', 'claude-code')]);
    await screen.findByRole('option', { name: /demo-host/ });
    await user.selectOptions(screen.getByLabelText('本次评估对象'), 'a');
    const run = await screen.findByRole('button', { name: /运行态测评/ });
    expect(run).toHaveTextContent('下发后由终端自动领取并执行');
    expect(run).not.toHaveTextContent(/审批|管理员/);
  });

  it('自管终端生成的对象：两张终端卡均可直接进入共用检测面板', async () => {
    const user = userEvent.setup();
    const fleet = {
      id: 'f1',
      name: 'demo-host（Linux）',
      provider: 'jiandun-fleet',
      targetType: 'ENDPOINT_AGENT',
      isActive: true,
      accessConfig: { fleetEndpointId: 'uuid-1', endpointId: 'a', endpointLabel: 'demo-host' },
    } as unknown as ModelTarget;
    renderSel([fleet]);
    // 下拉标签：自管终端不显示「未知产品 · 状态未知」
    const option = await screen.findByRole('option', { name: /demo-host/ });
    expect(option).toHaveTextContent('demo-host（Linux） · 鉴盾自管终端');
    expect(option).not.toHaveTextContent(/未知|状态/);
    await user.selectOptions(screen.getByLabelText('本次评估对象'), 'f1');
    const run = await screen.findByRole('button', { name: /运行态测评/ });
    expect(run).toBeEnabled();
    expect(run).not.toHaveTextContent('请在「终端」页发起');
    expect(screen.getByRole('button', { name: /^配置体检/ })).toBeEnabled();
  });

  it('关闭旧连接器不隐藏已接入的自管终端', async () => {
    mocks.config.mockResolvedValue({ enabled: false });
    renderSel([
      {
        id: 'f1',
        name: '研发电脑',
        provider: 'jiandun-fleet',
        targetType: 'ENDPOINT_AGENT',
        accessConfig: { fleetEndpointId: 'uuid-1' },
        isActive: true,
      } as unknown as ModelTarget,
    ]);
    expect(await screen.findByRole('option', { name: /研发电脑/ })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('本次评估对象'), 'f1');
    expect(screen.getByRole('button', { name: /运行态测评/ })).toBeEnabled();
  });

  it('没有终端对象时给空状态与「查看终端」，点击进入终端页的「接入终端」页签', async () => {
    const user = userEvent.setup();
    renderSel([MODEL]);
    expect(await screen.findByText('尚未发现可评估的终端智能体。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看终端' }));
    expect(await screen.findByText('终端页 /fleet?tab=enroll')).toBeInTheDocument();
  });

  it('终端测评未启用时不展示终端分组和空状态', async () => {
    mocks.config.mockResolvedValue({ enabled: false, agentshieldBaseUrl: '' });
    renderSel([MODEL, ep('a', 'claude-code')]);
    await screen.findByRole('option', { name: /对话模型/ });
    expect(screen.queryByText('尚未发现可评估的终端智能体。')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '终端智能体' })).not.toBeInTheDocument();
  });
});
