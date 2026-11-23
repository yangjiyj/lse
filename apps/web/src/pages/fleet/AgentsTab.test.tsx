import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { AgentsTab } from './AgentsTab';

const m = vi.hoisted(() => ({ agents: vi.fn(), setOwner: vi.fn(), users: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { fleet: { agents: m.agents, setOwner: m.setOwner }, users: { list: m.users } } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

it('shows current readiness and links a specific agent to the wizard', async () => {
  m.agents.mockResolvedValue({ items: [
    { endpointId: 'ep1', endpointName: 'demo-host', user: 'yj', os: 'linux', source: 'jiandun',
      agentKey: 'claude-code', agentName: 'Claude Code', version: '1.0', status: 'ready', scope: 'all', reason: null,
      latest: { jobId: 'job1', taskId: 'task1', status: 'COMPLETED', createdAt: '2026-10-31T12:00:00Z', conclusion: '发现风险' } },
    { endpointId: 'ep2', endpointName: 'work-2', user: 'user', os: 'linux', source: 'jiandun',
      agentKey: 'codex', agentName: 'Codex', version: null, status: 'needs_attention', scope: 'classic_only', reason: '尚未登记', latest: null },
  ], total: 2, page: 1, pageSize: 20 });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><AgentsTab /></MemoryRouter>
  </QueryClientProvider>);
  const row = (await screen.findByText('Claude Code')).closest('tr')!;
  expect(within(row).getByText(/全部样本/)).toBeInTheDocument();
  expect(within(row).getByText('发现风险')).toBeInTheDocument();
  expect(within(row).getByRole('link', { name: '发起测评' })).toHaveAttribute('href', '/agent-evals/new?endpoint=ep1&agent=claude-code');
  await userEvent.click(screen.getByRole('button', { name: '处理 Codex' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('尚未登记');
  expect(screen.getByRole('dialog')).toHaveTextContent('/etc/agent-platform-managed/eval-registry.json');
});

it('按终端分组：分组头显示责任人、资产与风险，智能体行显示自己的资产；可以设置责任人', async () => {
  m.agents.mockResolvedValue({
    items: [
      { endpointId: 'ep1', endpointName: 'demo-host', user: 'root', os: 'linux', source: 'jiandun',
        agentKey: 'claude-code', agentName: 'Claude Code', version: '2.1.308', status: 'ready', scope: 'all', reason: null,
        latest: { jobId: 'job1', taskId: 'task1', status: 'COMPLETED', createdAt: '2026-11-02T00:25:00Z', conclusion: '失败 · 证据不足，需重测' },
        assets: { skills: 86, mcp: 2 } },
      { endpointId: 'ep1', endpointName: 'demo-host', user: 'root', os: 'linux', source: 'jiandun',
        agentKey: 'gemini', agentName: 'Gemini', version: null, status: 'unsupported', scope: 'classic_only', reason: null,
        latest: null, assets: { skills: 0, mcp: 0 } },
      { endpointId: 'as1', endpointName: 'YJ40B4', user: 'YJ40B4$', os: 'windows', source: 'agentshield',
        agentKey: 'codex', agentName: 'Codex', version: null, status: 'needs_attention', scope: 'classic_only', reason: '未登记', latest: null, assets: null },
    ],
    groups: [
      { key: 'jiandun\u0000ep1', endpointId: 'ep1', source: 'jiandun', name: 'demo-host', os: 'linux', osUser: 'root', online: true,
        owner: { name: '张三', department: '研发部', userId: null, updatedAt: null }, ownerSource: 'manual',
        assets: { agents: 8, skills: 88, mcp: 2, platforms: 1 }, risks: { open: 10, high: 4 } },
      { key: 'agentshield\u0000as1', endpointId: 'as1', source: 'agentshield', name: 'YJ40B4', os: 'windows', osUser: null, online: null,
        owner: { name: 'YJ40B4$', department: null, userId: null, updatedAt: null }, ownerSource: 'reported', assets: null, risks: null },
    ],
    total: 2, page: 1, pageSize: 10,
  });
  m.users.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
  m.setOwner.mockResolvedValue({ id: 'ep1', owner: { name: '李四', department: '运维部', userId: null, updatedAt: null } });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider><MemoryRouter><AgentsTab /></MemoryRouter></ToastProvider>
  </QueryClientProvider>);
  const [head] = await screen.findAllByTestId('endpoint-group');
  expect(head).toHaveTextContent('张三（研发部）');
  expect(head).toHaveTextContent('资产：智能体 8 · Skill 88 · MCP 2 · 平台 1');
  expect(within(head!).getByRole('link', { name: '风险 10（高危 4）' })).toHaveAttribute('href', '/fleet/endpoints/ep1');
  expect(m.agents).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'endpoint' }));
  const row = screen.getByText('Claude Code').closest('tr')!;
  expect(within(row).getByText('Skill 86 · MCP 2')).toBeInTheDocument();
  // 智能体安全平台来源：显示平台上报的使用人，不能在这里改
  const heads = screen.getAllByTestId('endpoint-group');
  expect(heads[1]).toHaveTextContent('YJ40B4$');
  expect(heads[1]).toHaveTextContent('平台上报');
  expect(within(heads[1]!).queryByRole('button', { name: /责任人/ })).toBeNull();

  await userEvent.click(within(head!).getByRole('button', { name: '修改 demo-host 的责任人' }));
  const dialog = await screen.findByRole('dialog');
  const name = within(dialog).getByLabelText(/责任人/);
  await userEvent.clear(name);
  await userEvent.type(name, '李四');
  const dept = within(dialog).getByLabelText('部门');
  await userEvent.clear(dept);
  await userEvent.type(dept, '运维部');
  await userEvent.click(within(dialog).getByRole('button', { name: '保存' }));
  expect(m.setOwner).toHaveBeenCalledWith('ep1', { name: '李四', department: '运维部', userId: null });
});

it('平台来源按机器合并：endpointId 不同的登记行归到同一个分组头下', async () => {
  const machine = 'agentshield\u0000host:pskc|linux';
  const row = (endpointId: string, agentKey: string, agentName: string, version: string | null) => ({
    groupKey: machine, endpointId, endpointName: 'pskc', user: null, os: 'linux', source: 'agentshield',
    agentKey, agentName, version, status: 'needs_attention', scope: 'classic_only', reason: null, latest: null, assets: null });
  m.agents.mockResolvedValue({
    items: [row('reg-aiprobe', 'claude-code', 'Claude Code', '2.1.318'), row('reg-gemini', 'gemini', 'Gemini', '')],
    groups: [{ key: machine, endpointId: 'reg-aiprobe', source: 'agentshield', name: 'pskc', os: 'linux', osUser: null, online: null,
      owner: null, ownerSource: null, assets: null, risks: null }],
    total: 1, page: 1, pageSize: 10,
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider><MemoryRouter><AgentsTab /></MemoryRouter></ToastProvider>
  </QueryClientProvider>);
  expect(await screen.findAllByTestId('endpoint-group')).toHaveLength(1);
  expect(screen.getByText('Claude Code')).toBeInTheDocument();
  expect(screen.getByText('Gemini')).toBeInTheDocument();
});

it('平台来源的终端离线时，分组头同样显示离线徽标', async () => {
  const group = (key: string, name: string, online: boolean) => ({ key, endpointId: key, source: 'agentshield', name, os: 'linux',
    osUser: null, online, owner: null, ownerSource: null, assets: null, risks: null });
  const row = (key: string, name: string, status: string) => ({ groupKey: key, endpointId: key, endpointName: name, user: null, os: 'linux',
    source: 'agentshield', agentKey: 'codex', agentName: 'Codex', version: null, status, scope: 'classic_only', reason: null, latest: null, assets: null });
  m.agents.mockResolvedValue({
    items: [row('g-off', 'silent-host', 'offline'), row('g-on', 'alive-host', 'needs_attention')],
    groups: [group('g-off', 'silent-host', false), group('g-on', 'alive-host', true)],
    total: 2, page: 1, pageSize: 10,
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider><MemoryRouter><AgentsTab /></MemoryRouter></ToastProvider>
  </QueryClientProvider>);
  const [off, on] = await screen.findAllByTestId('endpoint-group');
  expect(within(off!).getByText('离线')).toBeInTheDocument();
  expect(within(on!).queryByText('离线')).toBeNull();
});

it('平台来源在线的行显示「平台管理」，没有「需处理」和「处理」；上报了测评执行器的给出登记评估对象的入口', async () => {
  const row = (endpointId: string, agentKey: string, agentName: string, status: string, evalRunnerVersion: string | null) => ({
    groupKey: 'g', endpointId, endpointName: 'pskc', user: null, os: 'linux', source: 'agentshield', agentKey, agentName,
    version: '1', status, scope: 'classic_only', reason: null, latest: null, assets: null, evalRunnerVersion });
  m.agents.mockResolvedValue({
    items: [
      row('reg-claude', 'claude-code', 'Claude Code', 'platform_managed', '1.4.0'),
      row('reg-codex', 'codex', 'Codex', 'platform_managed', null),
      row('reg-gemini', 'gemini', 'Gemini', 'platform_managed', '1.4.0'),
      row('reg-opencode', 'opencode', 'OpenCode', 'offline', '1.4.0'),
    ],
    groups: [{ key: 'g', endpointId: 'reg-claude', source: 'agentshield', name: 'pskc', os: 'linux', osUser: null, online: true,
      owner: null, ownerSource: null, assets: null, risks: null }],
    total: 1, page: 1, pageSize: 10,
  });
  function TargetsProbe() {
    return <div data-testid="register-state">{JSON.stringify(useLocation().state)}</div>;
  }
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider><MemoryRouter initialEntries={['/fleet']}><Routes>
      <Route path="/fleet" element={<AgentsTab />} />
      <Route path="/model-targets" element={<TargetsProbe />} />
    </Routes></MemoryRouter></ToastProvider>
  </QueryClientProvider>);
  const claude = (await screen.findByText('Claude Code')).closest('tr')!;
  expect(within(claude).getByText('平台管理')).toBeInTheDocument();
  expect(screen.queryByText('需处理')).toBeNull();
  expect(screen.queryByRole('button', { name: /^处理/ })).toBeNull();
  // 没上报测评执行器、表单不认识的产品、离线的登记：操作列都是「—」。
  for (const name of ['Codex', 'Gemini', 'OpenCode']) {
    const tr = screen.getByText(name).closest('tr')!;
    expect(within(tr).queryByRole('link', { name: '登记为评估对象' })).toBeNull();
    expect(within(tr).getByText('—', { selector: 'td[data-label="操作"] *' })).toBeInTheDocument();
  }
  await userEvent.click(within(claude).getByRole('link', { name: '登记为评估对象' }));
  expect(JSON.parse((await screen.findByTestId('register-state')).textContent!)).toEqual({ registerEndpoint: {
    endpointId: 'reg-claude', hostname: 'pskc', product: 'claude-code', name: 'pskc 终端(Claude Code)' } });
});
