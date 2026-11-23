import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { AgentEvalWizardPage } from './AgentEvalWizardPage';

const m = vi.hoisted(() => ({ endpoints: vi.fn(), overview: vi.fn(), endpoint: vi.fn(),
  samples: vi.fn(), plans: vi.fn(), estimate: vi.fn(), batch: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: {
  fleet: { endpoints: m.endpoints, endpoint: m.endpoint, overview: m.overview, estimateEvalJobs: m.estimate, createEvalBatch: m.batch },
  agentSamples: { list: m.samples, plans: m.plans, get: vi.fn() },
} }));
const agent = { product: 'claude-code', displayName: 'Claude Code', version: '1.0', liveEvalSupported: true,
  liveEvalRegistered: true, runtimeV2: true };
const endpoint = { id: 'ep1', hostname: 'demo-host', osUser: 'yj', online: true, status: 'ACTIVE', evalRunner: '1', agents: [agent] };
const sample = { id: 'vec-direct-creds-backup', suite: 'runtime_v2', title: '凭据备份', vectorLabel: '直接请求',
  harmLabel: '读取凭据', locations: ['用户直接要求'], agents: ['claude-code'], environment: 'sandbox', template: 'py-service-v1' };

it('清楚显示当前步骤并将智能体放在可展开的选择器中', async () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/agent-evals/new?endpoint=ep1&agent=claude-code']}><AgentEvalWizardPage /></MemoryRouter>
  </QueryClientProvider>);
  expect(await screen.findByText('demo-host')).toBeInTheDocument();
  expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('对象');
  expect(screen.getByRole('button', { name: /选择智能体/ })).toBeInTheDocument();
  expect(screen.queryByLabelText('查找终端')).not.toBeInTheDocument();
});
beforeEach(() => {
  vi.clearAllMocks();
  m.endpoints.mockResolvedValue({ items: [endpoint], total: 1, page: 1, pageSize: 100 });
  m.endpoint.mockResolvedValue({ ...endpoint, health: { capabilities: { eval_sandbox_v2: '1' } } });
  m.overview.mockResolvedValue({ agents: [{ key: 'claude-code', name: 'Claude Code', version: '1.0',
    liveEval: { supported: true, registered: true, reason: null }, runtimeV2: true }] });
  m.samples.mockResolvedValue({ items: [sample] });
  m.plans.mockResolvedValue({ items: [] });
  m.estimate.mockResolvedValue({ scenarioCount: 1, estimateSeconds: 160, modelUsage: null,
    jobs: [{ product: 'claude-code', suite: 'runtime_v2', scenarioCount: 1, estimateSeconds: 160,
      scenarios: [{ sampleId: sample.id, scenarioId: 'run-1', title: sample.title, template: 'py-service-v1', arm: 'observe' }] }] });
  m.batch.mockResolvedValue({ jobs: [{ taskId: 'task-1' }], scenarioCount: 1, estimateSeconds: 160 });
});

it('uses the selected endpoint and sample, requests an estimate and submits only after confirmation', async () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter initialEntries={['/agent-evals/new?endpoint=ep1&agent=claude-code&sample=vec-direct-creds-backup']}>
      <AgentEvalWizardPage />
    </MemoryRouter>
  </QueryClientProvider>);
  expect(await screen.findByText('demo-host')).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: '选择智能体' }));
  expect(await screen.findByRole('checkbox', { name: /Claude Code/ })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect(await screen.findByRole('checkbox', { name: /凭据备份/ })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  await waitFor(() => expect(m.estimate).toHaveBeenCalled());
  expect(await screen.findByText(/约 3 分钟/)).toBeInTheDocument();
  const submit = screen.getByRole('button', { name: '发起测评' });
  expect(submit).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: /确认/ }));
  await userEvent.click(submit);
  await waitFor(() => expect(m.batch).toHaveBeenCalledWith('ep1', expect.objectContaining({
    products: ['claude-code'], sampleIds: ['vec-direct-creds-backup'], arms: ['observe'], acknowledged: true,
  })));
  expect(await screen.findByRole('link', { name: /查看任务/ })).toHaveAttribute('href', '/eval-tasks/task-1');
});

it('does not show an unsupported preselected agent as checked and lets the user clear the sample', async () => {
  const codex = { ...agent, product: 'codex', displayName: 'Codex', runtimeV2: false };
  m.endpoint.mockResolvedValue({ ...endpoint, agents: [codex], health: { capabilities: {} } });
  m.overview.mockResolvedValue({ agents: [{ key: 'codex', name: 'Codex', version: '1.0',
    liveEval: { supported: true, registered: true, reason: null }, runtimeV2: false }] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/agent-evals/new?endpoint=ep1&agent=codex&sample=vec-direct-creds-backup']}>
      <AgentEvalWizardPage />
    </MemoryRouter>
  </QueryClientProvider>);
  await userEvent.click(await screen.findByRole('button', { name: '选择智能体' }));
  const checkbox = await screen.findByRole('checkbox', { name: /Codex/ });
  expect(checkbox).toBeDisabled();
  expect(checkbox).not.toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: '清除样本选择' }));
  expect(checkbox).toBeEnabled();
});

it('does not permit a runtime sample when another agent is selected', async () => {
  const codex = { ...agent, product: 'codex', displayName: 'Codex', runtimeV2: false };
  m.endpoint.mockResolvedValue({ ...endpoint, agents: [agent, codex], health: { capabilities: { eval_sandbox_v2: '1' } } });
  m.overview.mockResolvedValue({ agents: [
    { key: 'claude-code', name: 'Claude Code', version: '1.0', liveEval: { supported: true, registered: true, reason: null }, runtimeV2: true },
    { key: 'codex', name: 'Codex', version: '1.0', liveEval: { supported: true, registered: true, reason: null }, runtimeV2: false },
  ] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/agent-evals/new?endpoint=ep1&agent=codex']}><AgentEvalWizardPage /></MemoryRouter>
  </QueryClientProvider>);
  await userEvent.click(await screen.findByRole('button', { name: '选择智能体' }));
  expect(await screen.findByRole('checkbox', { name: /Codex/ })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect(await screen.findByRole('checkbox', { name: /凭据备份/ })).toBeDisabled();
  expect(screen.getByText('仅支持 Claude Code')).toBeInTheDocument();
  expect(m.batch).not.toHaveBeenCalled();
});

it('按投毒位置、靶场项目和适用智能体筛选样本', async () => {
  const other = { ...sample, id: 'sample-node', title: '依赖说明', locations: ['依赖 README'], template: 'node-api-v1' };
  m.samples.mockResolvedValue({ items: [sample, other] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/agent-evals/new?endpoint=ep1&agent=claude-code']}><AgentEvalWizardPage /></MemoryRouter>
  </QueryClientProvider>);
  await userEvent.click(await screen.findByRole('button', { name: '选择智能体' }));
  await screen.findByRole('checkbox', { name: /Claude Code/ });
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  await userEvent.selectOptions(await screen.findByLabelText('投毒位置'), '依赖 README');
  expect(screen.getByText('依赖说明')).toBeInTheDocument();
  expect(screen.queryByText('凭据备份')).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText('靶场项目筛选'), 'node-api-v1');
  await userEvent.selectOptions(screen.getByLabelText('适用智能体'), 'claude-code');
  expect(screen.getByText('依赖说明')).toBeInTheDocument();
});

it('当前能力读取失败时不能继续发起', async () => {
  m.overview.mockRejectedValue(new Error('网络错误'));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/agent-evals/new?endpoint=ep1&agent=claude-code']}><AgentEvalWizardPage /></MemoryRouter>
  </QueryClientProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('终端能力读取失败');
  expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
});

it('样本分页切换后保留已选项', async () => {
  const many = Array.from({ length: 15 }, (_, index) => ({ ...sample, id: `sample-${index}`, title: `样本 ${index}` }));
  m.samples.mockResolvedValue({ items: many });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/agent-evals/new?endpoint=ep1&agent=claude-code']}><AgentEvalWizardPage /></MemoryRouter>
  </QueryClientProvider>);
  await userEvent.click(await screen.findByRole('button', { name: '选择智能体' }));
  await screen.findByRole('checkbox', { name: /Claude Code/ });
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  await userEvent.click(await screen.findByRole('checkbox', { name: /^样本 0/ }));
  expect(screen.queryByRole('checkbox', { name: /^样本 14/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(screen.getByRole('checkbox', { name: /^样本 14/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '上一页' }));
  expect(screen.getByRole('checkbox', { name: /^样本 0/ })).toBeChecked();
});

it('confirms and submits mixed classic and sandbox samples as one batch', async () => {
  const classic = { ...sample, id: 'endpoint-readme-injection', suite: 'classic', title: '项目说明诱导', environment: 'real_config' };
  m.samples.mockResolvedValue({ items: [sample, classic] });
  m.estimate.mockResolvedValue({ scenarioCount: 2, estimateSeconds: 430, modelUsage: null, jobs: [
    { product: 'claude-code', suite: 'classic', scenarioCount: 1, estimateSeconds: 270,
      scenarios: [{ sampleId: classic.id, scenarioId: classic.id, title: classic.title, template: null, arm: null }] },
    { product: 'claude-code', suite: 'runtime_v2', scenarioCount: 1, estimateSeconds: 160,
      scenarios: [{ sampleId: sample.id, scenarioId: 'run-1', title: sample.title, template: 'py-service-v1', arm: 'observe' }] },
  ] });
  m.batch.mockResolvedValue({ jobs: [{ taskId: 'classic-task' }, { taskId: 'runtime-task' }], scenarioCount: 2, estimateSeconds: 430 });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter initialEntries={['/agent-evals/new?endpoint=ep1&agent=claude-code']}><AgentEvalWizardPage /></MemoryRouter>
  </QueryClientProvider>);
  await userEvent.click(await screen.findByRole('button', { name: '选择智能体' }));
  expect(await screen.findByRole('checkbox', { name: /Claude Code/ })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  await userEvent.click(await screen.findByRole('checkbox', { name: /凭据备份/ }));
  await userEvent.click(screen.getByRole('checkbox', { name: /项目说明诱导/ }));
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect(await screen.findByText(/真实主目录配置/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('checkbox', { name: /确认/ }));
  await userEvent.click(screen.getByRole('button', { name: '发起测评' }));
  await waitFor(() => expect(m.batch).toHaveBeenCalledWith('ep1', expect.objectContaining({
    sampleIds: [sample.id, classic.id], acknowledged: true,
  })));
  expect(await screen.findAllByRole('link', { name: /查看任务/ })).toHaveLength(2);
});

it('场景较多被拆成多个任务时，每个任务标明第几批并说明依次执行', async () => {
  m.estimate.mockResolvedValue({ scenarioCount: 60, estimateSeconds: 9600, modelUsage: null,
    jobs: [1, 2].map((index) => ({ product: 'claude-code', suite: 'runtime_v2', scenarioCount: 30, estimateSeconds: 4800,
      batch: { index, total: 2 },
      scenarios: [{ sampleId: sample.id, scenarioId: `run-${index}`, title: sample.title, template: 'py-service-v1', arm: 'observe' }] })) });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter initialEntries={['/agent-evals/new?endpoint=ep1&agent=claude-code&sample=vec-direct-creds-backup']}>
      <AgentEvalWizardPage />
    </MemoryRouter>
  </QueryClientProvider>);
  expect(await screen.findByText('demo-host')).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: '选择智能体' }));
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect(await screen.findByText(/第 1\/2 批/)).toBeInTheDocument();
  expect(screen.getByText(/第 2\/2 批/)).toBeInTheDocument();
  expect(screen.getByText(/拆成 2 个任务依次执行/)).toBeInTheDocument();
});

it('没有拆批时不显示批次和拆分说明', async () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter initialEntries={['/agent-evals/new?endpoint=ep1&agent=claude-code&sample=vec-direct-creds-backup']}>
      <AgentEvalWizardPage />
    </MemoryRouter>
  </QueryClientProvider>);
  expect(await screen.findByText('demo-host')).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: '选择智能体' }));
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  await userEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect(await screen.findByText(/1 个场景/)).toBeInTheDocument();
  expect(screen.queryByText(/批/)).not.toBeInTheDocument();
});
