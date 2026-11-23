import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { EndpointAgentFields, EndpointTaskStatus } from './EndpointAgentFields';
const mocks = vi.hoisted(() => ({ empty: false, failing: false }));
vi.mock('@/lib/api', () => ({
  api: {
    endpointEvals: {
      endpoints: async () =>
        mocks.failing
          ? Promise.reject(new Error('x'))
          : mocks.empty
            ? []
            : [
                {
                  endpoint_id: 'e',
                  hostname: '研发电脑',
                  eval_runner_version: null,
                  agents: [{ product: 'codex', headless_capable: false }],
                },
                {
                  endpoint_id: 'w',
                  hostname: '视窗电脑',
                  os: 'windows',
                  eval_runner_version: '1',
                  agents: [{ product: 'codex', headless_capable: true }],
                },
              ],
    },
  },
}));
it('显示中文端点下拉框和仅体检提示', async () => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <EndpointAgentFields
        product="codex"
        endpointId="e"
        onProductChange={vi.fn()}
        onEndpointChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('option', { name: /研发电脑/ })).toBeInTheDocument();
  const hint = screen.getByTestId('endpoint-no-live-eval');
  expect(hint).toHaveTextContent('该终端不支持真机测评，仅可做配置体检。');
  expect(hint).toHaveTextContent('重新运行安装包或一键命令');
  expect(screen.getByLabelText('终端智能体产品')).toBeInTheDocument();
});
it('历史任务的状态说明原样显示（升级前遗留的任务可能还写着旧措辞）', () => {
  render(<EndpointTaskStatus targetType="ENDPOINT_AGENT" description="等待终端审批" />);
  expect(screen.getByText('等待终端审批')).toBeInTheDocument();
});
it('超长 description 只显示一行摘要，完整内容放 title', () => {
  const long = '原始日志'.repeat(1000);
  render(<EndpointTaskStatus targetType="ENDPOINT_AGENT" description={long} />);
  const el = screen.getByTitle(/原始日志/);
  expect(el.textContent!.length).toBeLessThanOrEqual(81);
  expect(el.textContent!.endsWith('…')).toBe(true);
  expect(el.className).toContain('truncate');
});
it('普通任务不显示终端状态', () => {
  const { container } = render(<EndpointTaskStatus targetType="MODEL" description="内部配置" />);
  expect(container).toBeEmptyDOMElement();
});

it('Windows 终端可真机测评，并提示只有钩子防护', async () => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <EndpointAgentFields
        product="codex"
        endpointId="w"
        onProductChange={vi.fn()}
        onEndpointChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('option', { name: /视窗电脑/ })).toBeInTheDocument();
  expect(screen.queryByTestId('endpoint-no-live-eval')).not.toBeInTheDocument();
  expect(screen.getByText(/Windows 终端没有系统级沙箱/)).toBeInTheDocument();
});
it('终端为空时的引导不使用必要条件措辞，并指向终端页的接入终端页签', async () => {
  mocks.empty = true;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <EndpointAgentFields
          product="codex"
          endpointId=""
          onProductChange={vi.fn()}
          onEndpointChange={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const guide = await screen.findByTestId('endpoint-empty-guide');
  expect(guide).toHaveTextContent(
    '尚未发现已接入的终端。已接入智能体安全平台的终端会自动出现在这里',
  );
  expect(guide.textContent).not.toMatch(/才能|必须先|需要先/);
  expect(screen.getByRole('link', { name: '查看接入终端' })).toHaveAttribute(
    'href',
    '/fleet?tab=enroll',
  );
  mocks.empty = false;
});

it('终端列表加载失败：不再指向不存在的「平台设置 → 智能体安全平台联动」', async () => {
  mocks.failing = true;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <EndpointAgentFields
          product="codex"
          endpointId=""
          onProductChange={vi.fn()}
          onEndpointChange={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('智能体安全平台地址未配置，或平台暂时无法访问');
  expect(alert).toHaveTextContent('请联系部署管理员确认部署配置');
  expect(alert).not.toHaveTextContent(/平台设置|智能体安全平台联动/);
  expect(screen.queryByRole('link', { name: /平台设置/ })).not.toBeInTheDocument();
  mocks.failing = false;
});

it('产品选项来自共享清单，包含新增的三种智能体', () => {
  render(<QueryClientProvider client={new QueryClient()}><EndpointAgentFields product="opencode" endpointId="" onProductChange={vi.fn()} onEndpointChange={vi.fn()} /></QueryClientProvider>);
  for (const name of ['Claude Code', 'Codex', 'OpenCode', 'OpenClaw', 'Hermes']) expect(screen.getByRole('option', { name })).toBeInTheDocument();
});
