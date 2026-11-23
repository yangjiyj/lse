import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { AgentRangePage } from './AgentRangePage';

const range = {
  decoys: [
    { id: 'aws', label: 'AWS 凭据', path: '~/.aws/credentials', purpose: '测智能体会不会读取或外传云服务访问密钥', usedBy: 3 },
    { id: 'env_file', label: '项目环境变量文件', path: '.env', purpose: '放着云服务、支付、邮件的假密钥', usedBy: 0 },
  ],
  projects: [
    { template: 'py-service-v1', name: 'Python 库存服务', files: [
      { path: 'README.md', slot: 'readme_note', label: '项目说明（README）', usedBy: 2 },
      { path: 'Makefile', slot: 'makefile_note', label: '构建脚本 Makefile', usedBy: 0 },
    ] },
    { template: 'node-api-v1', name: 'Node 订单接口', files: [{ path: 'package.json', slot: 'package_script', label: 'package.json 的 setup 脚本', usedBy: 1 }] },
  ],
  mcp: [
    { kind: 'poisoned_description', label: '工具描述投毒', description: '工具的描述文字里夹带恶意指令。', usedBy: 4 },
    { kind: 'rug_pull', label: '工具中途换包', description: '前几次调用正常，之后工具描述悄悄变化。', usedBy: 0 },
  ],
  receiverBase: 'https://example.invalid', receiverReachable: null,
  recentReceipts: [{ id: 'receipt-1', taskId: 'task-1', createdAt: '2026-11-01T10:00:00Z' }],
};
const endpoints = (items: unknown[]) => vi.fn(async () => ({ items, total: items.length, page: 1, pageSize: 20 }));
const apiMock = vi.hoisted(() => ({ range: vi.fn(), endpoints: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { agentSamples: { range: apiMock.range }, fleet: { endpoints: apiMock.endpoints } } }));

const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <MemoryRouter><AgentRangePage /></MemoryRouter>
</QueryClientProvider>);

it('顶部三张状态卡：隔离能力、受控接收端、蜜标种数', async () => {
  apiMock.range.mockResolvedValue(range);
  apiMock.endpoints.mockImplementation(endpoints([
    { id: 'ep1', hostname: 'demo-host', status: 'ACTIVE', online: true, agents: [{ product: 'claude-code', runtimeV2: true }] },
    { id: 'ep2', hostname: 'old-box', status: 'ACTIVE', online: false, agents: [{ product: 'codex', runtimeV2: false }] },
  ]));
  renderPage();
  expect(await screen.findByText('1 / 2')).toBeInTheDocument();
  expect(screen.getByText('台终端支持蜜罐沙箱')).toBeInTheDocument();
  expect(await screen.findByText('https://example.invalid')).toBeInTheDocument();
  expect(screen.getByText('可达性未检测')).toBeInTheDocument();
  expect(screen.getByText('2 种')).toBeInTheDocument();
});

it('终端表用「蜜罐沙箱」「仅配置检测」表示能力，不显示内部隔离名', async () => {
  apiMock.range.mockResolvedValue(range);
  apiMock.endpoints.mockImplementation(endpoints([
    { id: 'ep1', hostname: 'demo-host', status: 'ACTIVE', online: true, agents: [{ product: 'claude-code', runtimeV2: true }] },
    { id: 'ep2', hostname: 'old-box', status: 'ACTIVE', online: false, agents: [{ product: 'codex', runtimeV2: false }] },
  ]));
  renderPage();
  const row1 = (await screen.findByRole('link', { name: 'demo-host' })).closest('tr')!;
  expect(within(row1).getByText('在线')).toBeInTheDocument();
  expect(within(row1).getByText('蜜罐沙箱')).toBeInTheDocument();
  const row2 = screen.getByRole('link', { name: 'old-box' }).closest('tr')!;
  expect(within(row2).getByText('离线')).toBeInTheDocument();
  expect(within(row2).getByText('仅配置检测')).toBeInTheDocument();
  expect(screen.queryByText('bwrap-v2')).not.toBeInTheDocument();
});

it('靶场项目是文件树卡片：文件路径、位置名称和被几条样本使用，不显示内部插槽名', async () => {
  apiMock.range.mockResolvedValue(range);
  apiMock.endpoints.mockImplementation(endpoints([]));
  renderPage();
  const card = (await screen.findByRole('heading', { name: 'Python 库存服务' })).closest('section')!;
  expect(within(card).getByText('README.md')).toBeInTheDocument();
  expect(within(card).getByText('项目说明（README）')).toBeInTheDocument();
  expect(within(card).getByText('2 条样本')).toBeInTheDocument();
  expect(within(card).getByText('Makefile')).toBeInTheDocument();
  expect(within(card).getByText('未使用')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Node 订单接口' })).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/readme_note|makefile_note|package_script/);
});

it('蜜标表写清名称、放在哪、用来测什么和使用量，不显示内部标记名', async () => {
  apiMock.range.mockResolvedValue(range);
  apiMock.endpoints.mockImplementation(endpoints([]));
  renderPage();
  const row = (await screen.findByText('AWS 凭据')).closest('tr')!;
  expect(within(row).getByText('~/.aws/credentials')).toBeInTheDocument();
  expect(within(row).getByText('测智能体会不会读取或外传云服务访问密钥')).toBeInTheDocument();
  expect(within(row).getByText('3 条样本')).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/LSE-CANARY/);
});

it('受控接收端的最近记录可以点进任务；模拟 MCP 每种方式有说明', async () => {
  apiMock.range.mockResolvedValue(range);
  apiMock.endpoints.mockImplementation(endpoints([]));
  renderPage();
  expect(await screen.findByRole('link', { name: '查看任务' })).toHaveAttribute('href', '/eval-tasks/task-1');
  expect(screen.getByText('工具描述投毒')).toBeInTheDocument();
  expect(screen.getByText('工具的描述文字里夹带恶意指令。')).toBeInTheDocument();
  expect(screen.getByText('工具中途换包')).toBeInTheDocument();
});

it('接收端可达时写可达，不可达时写不可达', async () => {
  apiMock.range.mockResolvedValue({ ...range, receiverReachable: true });
  apiMock.endpoints.mockImplementation(endpoints([]));
  const first = renderPage();
  expect(await screen.findByText('可达')).toBeInTheDocument();
  first.unmount();
  apiMock.range.mockResolvedValue({ ...range, receiverReachable: false });
  renderPage();
  expect(await screen.findByText('不可达')).toBeInTheDocument();
});

it('读取失败时给出提示，不白屏', async () => {
  apiMock.range.mockRejectedValue(new Error('boom'));
  apiMock.endpoints.mockImplementation(endpoints([]));
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('靶场信息读取失败');
});
