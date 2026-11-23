import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { ModelTargetsPage } from './ModelTargetsPage';

const m = vi.hoisted(() => ({
  capabilities: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  diagnose: vi.fn(),
  diagnoseSaved: vi.fn(),
  batchTest: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    modelTargets: {
      capabilities: m.capabilities,
      list: m.list,
      create: m.create,
      update: vi.fn(),
      remove: vi.fn(),
      test: vi.fn(),
      diagnose: m.diagnose,
      diagnoseSaved: m.diagnoseSaved,
      batchTest: m.batchTest,
    },
    gatewayLogs: { analyze: vi.fn() },
    evalTasks: { list: vi.fn(), remove: vi.fn() },
    systemSettings: { get: vi.fn().mockResolvedValue({ gateway: { gatewayBaseUrl: '' } }) },
  },
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

const target = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  targetType: 'MODEL',
  provider: 'openai-compatible-local',
  model: 'qwen2.5',
  baseUrl: 'http://127.0.0.1:8000/v1',
  apiKeyMasked: null,
  hasApiKey: false,
  extraHeaders: null,
  defaultParams: null,
  accessConfig: null,
  isGlobal: false,
  isActive: true,
  lastTestStatus: null,
  lastTestedAt: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  createdBy: null,
  ...extra,
});

const report = {
  ok: false,
  httpStatus: 401,
  latencyMs: 12,
  contentType: 'application/json',
  streamFormat: null,
  answerSample: null,
  responseCandidates: [],
  detectedSessionField: null,
  detectedAsyncField: null,
  responsePreview: '{"error":"unauthorized"}',
  checks: [
    { key: 'network', label: '网络与出站策略', status: 'pass', message: '接口可达' },
    {
      key: 'auth',
      label: '认证',
      status: 'fail',
      message: '接口返回 401，认证失败',
      suggestion: '检查访问密钥是否正确、是否过期',
    },
  ],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <ModelTargetsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ModelTargetsPage 接入能力（参数 4、5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.capabilities.mockResolvedValue({ platformAppEnabled: false });
    m.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    m.create.mockResolvedValue({ id: 'new', name: 'x' });
    m.diagnose.mockResolvedValue(report);
    m.diagnoseSaved.mockResolvedValue(report);
  });

  it('关键列保留，标识与接入位置收进可展开详情', async () => {
    m.list.mockResolvedValue({ items: [target('layout', '长名称测试对象')], total: 1 });
    renderPage();
    const table = await screen.findByRole('table', { name: '评估对象列表' });
    expect(table).toHaveClass('table-fixed');
    expect(within(table).getByRole('columnheader', { name: '状态' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '最近测试' })).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: '接入位置' })).not.toBeInTheDocument();
    expect(within(table).getByText('接入详情', { selector: 'summary' })).toBeInTheDocument();
    expect(within(table).getByText('http://127.0.0.1:8000/v1')).toBeInTheDocument();
  });

  it('说明区展示招标原文；选择“国家管网集团标准模型接口”预设按 OpenAI 兼容提交', async () => {
    renderPage();
    expect(
      screen.getByText(
        /支持目标模型通过OpenAI兼容API接入，兼容本地模型服务、云端模型服务及国家管网集团标准模型接口。/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/支持非标准业务接口或等效E2E接入能力，接入模型应用、智能体应用。/),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
    await userEvent.selectOptions(await screen.findByLabelText('接入预设'), 'pipechina');
    expect(
      screen.getByText(/国家管网集团标准模型接口按 OpenAI 兼容 API 协议接入/),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^名称/), '管网标准模型');
    await userEvent.type(screen.getByLabelText(/AI 接口地址/), 'https://llm.example.com/v1');
    await userEvent.type(screen.getByLabelText(/模型名称/), 'std-model');
    await userEvent.type(screen.getByLabelText(/访问密钥（API Key）/), 'EMPTY');
    await userEvent.click(screen.getByRole('button', { name: /^保存$/ }));
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'MODEL', provider: 'pipechina-standard-openai' }),
    );
  });

  it('从 curl 导入：识别结果遮蔽认证字段，确认后填入非标准业务接口配置', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
    await userEvent.click(await screen.findByRole('button', { name: /从 curl 导入/ }));
    const secret = 'tok-abcdefghijklmnop'; // pragma: allowlist secret
    fireEvent.change(screen.getByLabelText(/curl 命令/), {
      target: {
        value: `curl https://agent.example.com/api/chat -H 'Authorization: Bearer ${secret}' -H 'Cookie: sid=zzzzzzzzzzzz' -d '{"query":"你好"}'`,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: '识别' }));
    const result = screen.getByRole('region', { name: 'curl 识别结果' });
    expect(within(result).queryByText(new RegExp(secret))).not.toBeInTheDocument();
    expect(within(result).queryByText(/sid=zzzzzzzzzzzz/)).not.toBeInTheDocument();
    expect(within(result).getByText(/已替换为 \{\{prompt\}\}/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '确认并填入表单' }));
    expect(screen.getByLabelText('对象类型')).toHaveValue('AGENT_API');
    expect((screen.getByLabelText(/请求模板/) as HTMLTextAreaElement).value).toContain(
      '{{prompt}}',
    );
    expect(screen.getByLabelText(/访问密钥（API Key）/)).toHaveAttribute('type', 'password');
  });

  it('表单“接口诊断”逐项显示结果与中文建议', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
    await userEvent.type(await screen.findByLabelText(/^名称/), 'm');
    await userEvent.type(screen.getByLabelText(/AI 接口地址/), 'https://api.example.com/v1');
    await userEvent.type(screen.getByLabelText(/模型名称/), 'gpt');
    await userEvent.type(screen.getByLabelText(/访问密钥（API Key）/), 'sk-x');
    await userEvent.click(screen.getByRole('button', { name: /接口诊断/ }));
    const view = await screen.findByRole('region', { name: '接入诊断结果' });
    expect(within(view).getByText('诊断发现问题')).toBeInTheDocument();
    expect(within(view).getByText('建议：检查访问密钥是否正确、是否过期')).toBeInTheDocument();
    expect(m.diagnose).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'MODEL' }));
  });

  it('列表显示接入类型标签，多选后批量连通性测试逐行显示结果', async () => {
    m.list.mockResolvedValue({
      items: [
        target('a', '本地模型A'),
        target('b', '云端模型B', { provider: 'openai-compatible-cloud' }),
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    });
    m.batchTest.mockResolvedValue({
      summary: { total: 2, success: 1, failed: 1, skipped: 0 },
      concurrency: 4,
      results: [
        {
          id: 'a',
          name: '本地模型A',
          status: 'SUCCESS',
          latencyMs: 120,
          httpStatus: 200,
          error: null,
        },
        {
          id: 'b',
          name: '云端模型B',
          status: 'ERROR',
          latencyMs: 30,
          httpStatus: 401,
          error: '认证失败',
        },
      ],
    });
    renderPage();
    expect(await screen.findByText('OpenAI 兼容 API · 本地模型服务')).toBeInTheDocument();
    expect(screen.getByText('OpenAI 兼容 API · 云端模型服务')).toBeInTheDocument();

    const batchBtn = screen.getByRole('button', { name: /批量连通性测试/ });
    expect(batchBtn).toBeDisabled();
    await userEvent.click(screen.getByLabelText('全选可测试对象'));
    await userEvent.click(batchBtn);
    await waitFor(() => expect(m.batchTest).toHaveBeenCalledWith(['a', 'b']));
    expect(await screen.findByRole('status')).toHaveTextContent('成功 1，失败 1');
    const rowB = screen.getByText('云端模型B').closest('tr')!;
    expect(within(rowB).getByText(/批量测试：失败 · HTTP 401/)).toBeInTheDocument();
    expect(within(rowB).getByText('认证失败')).toBeInTheDocument();
  });

  it('行内“接口诊断”调用已保存对象诊断并在弹窗展示', async () => {
    m.list.mockResolvedValue({
      items: [target('a', '本地模型A')],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    renderPage();
    const row = (await screen.findByText('本地模型A')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '更多' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /接口诊断/ }));
    await waitFor(() => expect(m.diagnoseSaved).toHaveBeenCalledWith('a'));
    expect(await screen.findByText('接口返回 401，认证失败')).toBeInTheDocument();
  });
});

describe('平台智能体接入', () => {
  it('关闭时隐藏入口', async () => {
    m.capabilities.mockResolvedValue({ platformAppEnabled: false });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
    expect(
      screen.queryByRole('option', { name: '平台智能体（Dify/扣子）' }),
    ).not.toBeInTheDocument();
  });

  it('开启后以中文表单填写平台配置并连接诊断', async () => {
    m.capabilities.mockResolvedValue({ platformAppEnabled: true });
    m.list.mockResolvedValue({ items: [], total: 0 });
    m.diagnose.mockResolvedValue(report);
    m.create.mockResolvedValue({ id: 'platform' });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
    await screen.findByRole('option', { name: '平台智能体（Dify/扣子）' });
    await userEvent.selectOptions(screen.getByLabelText('对象类型'), 'PLATFORM_APP');
    await userEvent.type(screen.getByLabelText(/^名称/), '扣子客服');
    await userEvent.selectOptions(screen.getByLabelText('平台'), 'coze');
    expect(screen.queryByLabelText('应用模式')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/机器人标识/), 'bot-123');
    await userEvent.type(screen.getByLabelText(/平台基地址/), 'https://api.coze.cn');
    await userEvent.type(screen.getByLabelText('应用密钥'), 'test-pat');
    await userEvent.click(screen.getByRole('button', { name: '连接诊断' }));
    await waitFor(() =>
      expect(m.diagnose).toHaveBeenCalledWith(
        expect.objectContaining({
          targetType: 'PLATFORM_APP',
          apiKey: 'test-pat',
          accessConfig: { platform: 'coze', baseUrl: 'https://api.coze.cn', botId: 'bot-123' },
        }),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /^保存$/ }));
    await waitFor(() =>
      expect(m.create).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: 'PLATFORM_APP' }),
      ),
    );
  });
});

it('能力关闭后隐藏已保存平台对象的连接测试与诊断入口', async () => {
  m.capabilities.mockResolvedValue({ platformAppEnabled: false });
  m.list.mockResolvedValue({
    items: [target('existing-platform', '已保存的平台', { targetType: 'PLATFORM_APP' })],
    total: 1,
  });
  renderPage();
  const row = (await screen.findByText('已保存的平台')).closest('tr')!;
  expect(within(row).queryByRole('button', { name: /^测试$/ })).not.toBeInTheDocument();
  expect(within(row).queryByRole('button', { name: /接口诊断/ })).not.toBeInTheDocument();
});
