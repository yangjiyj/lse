import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { ModelTargetsPage } from './ModelTargetsPage';

const authState = vi.hoisted(() => ({ user: undefined as unknown, denied: new Set<string>() }));

const apiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  analyzeGatewayLogs: vi.fn(),
  evalTasksList: vi.fn(),
  evalTasksRemove: vi.fn(),
  systemSettingsGet: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    modelTargets: {
      list: apiMock.list,
      create: apiMock.create,
      update: apiMock.update,
      remove: apiMock.remove,
      test: apiMock.test,
    },
    gatewayLogs: {
      analyze: apiMock.analyzeGatewayLogs,
    },
    evalTasks: {
      list: apiMock.evalTasksList,
      remove: apiMock.evalTasksRemove,
    },
    systemSettings: {
      get: apiMock.systemSettingsGet,
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => !authState.denied.has(code), user: authState.user }),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/model-targets']}>
          <Routes>
            <Route path="/model-targets" element={<ModelTargetsPage />} />
            <Route path="/eval-tasks/:taskId" element={<div>任务详情页</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ModelTargetsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.denied.clear();
    apiMock.list.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
    });
    apiMock.create.mockResolvedValue({
      id: 'target-1',
      name: '客户智能体应用',
    });
    apiMock.analyzeGatewayLogs.mockResolvedValue({
      task: { id: 'task-1', name: '网关日志风险分析' },
      summary: {
        totalEvents: 3,
        passedEvents: 2,
        riskEvents: 1,
        blockedEvents: 1,
      },
      findingCount: 1,
    });
    apiMock.evalTasksList.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    apiMock.evalTasksRemove.mockResolvedValue(undefined);
    apiMock.systemSettingsGet.mockResolvedValue({ gateway: { gatewayBaseUrl: '' } });
  });

  it('创建入口含「主动/被动」类型选择，但不含智能体专属字段', async () => {
    renderPage();

    expect(await screen.findByText('评估对象')).toBeInTheDocument();
    expect(screen.queryByText('辅助证据源')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
    await screen.findByLabelText(/^名称/);

    // 类型选择回归：对象类型与接入/采证方式拆开；仍无"请求模板 JSON"等未验证字段
    expect(screen.getByLabelText(/对象类型/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /AI 服务.*网关观测/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('请求模板')).not.toBeInTheDocument();
    // 默认被测对象(主动)：展示 AI 接口地址
    expect(screen.getByLabelText(/AI 接口地址/)).toBeInTheDocument();
  });

  it('非平台租户：新建时没有网关观测类型、不预填也不显示安全网关关联，提交不带网关', async () => {
    authState.user = { tenant: { id: 't-a', name: '甲单位', isPlatform: false } };
    try {
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: /新建评估对象/ }));
      await userEvent.type(await screen.findByLabelText(/^名称/), '租户模型');
      expect(screen.queryByRole('option', { name: /AI 服务.*网关观测/ })).toBeNull();
      expect(screen.queryByText('安全网关关联（选填）')).toBeNull();
      expect(screen.queryByLabelText(/安全网关地址（选填）/)).toBeNull();
      await userEvent.type(screen.getByLabelText(/AI 接口地址/), 'http://model:8080/v1');
      await userEvent.type(screen.getByLabelText(/模型名称/), 'qwen2.5');
      await userEvent.type(screen.getByLabelText(/访问密钥（API Key）/), 'sk-t');
      await userEvent.click(screen.getByRole('button', { name: /^保存$/ }));
      await waitFor(() => expect(apiMock.create).toHaveBeenCalledTimes(1));
      const payload = apiMock.create.mock.calls[0]![0] as { accessConfig?: Record<string, unknown> };
      expect(payload.accessConfig?.gatewayBaseUrl).toBeUndefined();
    } finally {
      authState.user = undefined;
    }
  });

  it('选「被动观测」后表单切换为网关身份字段(网关地址+Key+源IP)，隐藏主动测的 URL', async () => {
    renderPage();
    await screen.findByText('评估对象');
    await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
    await screen.findByLabelText(/^名称/);
    expect(screen.getByLabelText(/AI 接口地址/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/对象类型/), 'GATEWAY_LOG');

    // 切到被动观测：网关身份字段出现，主动测的 URL 消失
    expect(screen.getByLabelText(/网关地址/)).toBeInTheDocument();
    expect(screen.getByLabelText(/调用方标识/)).toBeInTheDocument();
    expect(screen.getByLabelText(/来源地址 IP/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/AI 接口地址/)).not.toBeInTheDocument();
  });

  it('被动观测·新建时「网关地址」自动取系统设置的全局网关地址，无需手填', async () => {
    apiMock.systemSettingsGet.mockResolvedValue({ gateway: { gatewayBaseUrl: '100.64.0.10' } });
    renderPage();
    await screen.findByText('评估对象');
    await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
    await screen.findByLabelText(/^名称/);
    await userEvent.selectOptions(screen.getByLabelText(/对象类型/), 'GATEWAY_LOG');

    await waitFor(() => expect(screen.getByLabelText(/网关地址/)).toHaveValue('100.64.0.10'));
  });

  it('创建被测对象提交 targetType=MODEL 与基础接入信息', async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
    await userEvent.type(await screen.findByLabelText(/^名称/), 'BoFlow 模型');
    await userEvent.type(screen.getByLabelText(/AI 接口地址/), 'https://api.example.com/v1');
    await userEvent.type(screen.getByLabelText(/模型名称/), 'qwen3.6-plus');
    await userEvent.type(screen.getByLabelText(/访问密钥（API Key）/), 'sk-test');

    await userEvent.click(screen.getByRole('button', { name: /^保存$/ }));

    await waitFor(() => expect(apiMock.create).toHaveBeenCalledTimes(1));
    expect(apiMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'BoFlow 模型',
        targetType: 'MODEL',
        baseUrl: 'https://api.example.com/v1',
        model: 'qwen3.6-plus',
        apiKey: 'sk-test', // pragma: allowlist secret
      }),
    );
  });

  it('被测对象填写网关证据源地址时，提交 payload 带 gatewayBaseUrl 与 tenantId', async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
    await userEvent.type(await screen.findByLabelText(/^名称/), '走网关的模型');
    await userEvent.type(screen.getByLabelText(/AI 接口地址/), 'http://gateway-core:8080/v1');
    await userEvent.type(screen.getByLabelText(/模型名称/), 'qwen2.5');
    await userEvent.type(screen.getByLabelText(/访问密钥（API Key）/), 'sk-gw');
    await userEvent.type(
      screen.getByLabelText(/安全网关地址（选填）/),
      'http://control-plane:8081',
    );
    await userEvent.type(screen.getByLabelText(/网关分区标识（选填）/), 'tenant_acme');

    await userEvent.click(screen.getByRole('button', { name: /^保存$/ }));

    await waitFor(() => expect(apiMock.create).toHaveBeenCalledTimes(1));
    expect(apiMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'MODEL',
        accessConfig: expect.objectContaining({
          gatewayBaseUrl: 'http://control-plane:8081',
          tenantId: 'tenant_acme',
        }),
      }),
    );
  });

  it('列表隐藏历史 JUDGE 对象，避免和被测对象混在一起', async () => {
    apiMock.list.mockResolvedValue({
      items: [
        {
          id: 'judge-1',
          name: 'AI复核',
          targetType: 'JUDGE',
          provider: 'openai-compatible',
          model: 'judge-model-1',
          baseUrl: 'https://judge.example.com/v1',
          apiKeyMasked: 'sk****1234', // pragma: allowlist secret
          hasApiKey: true,
          extraHeaders: null,
          defaultParams: null,
          accessConfig: null,
          isGlobal: true,
          isActive: true,
          lastTestStatus: null,
          lastTestedAt: null,
          createdAt: '2026-06-10T00:00:00.000Z',
          updatedAt: '2026-06-10T00:00:00.000Z',
          createdBy: null,
        },
        {
          id: 'model-1',
          name: 'qwen2.5 网关模型',
          targetType: 'MODEL',
          provider: 'newapi-gateway',
          model: 'qwen2.5',
          baseUrl: 'http://gateway-core:8080/v1',
          apiKeyMasked: 'sk****abcd', // pragma: allowlist secret
          hasApiKey: true,
          extraHeaders: null,
          defaultParams: null,
          accessConfig: null,
          isGlobal: true,
          isActive: true,
          lastTestStatus: null,
          lastTestedAt: null,
          createdAt: '2026-06-10T00:00:00.000Z',
          updatedAt: '2026-06-10T00:00:00.000Z',
          createdBy: null,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    });

    renderPage();

    expect(await screen.findByText('qwen2.5 网关模型')).toBeInTheDocument();
    expect(screen.queryByText('AI复核')).not.toBeInTheDocument();
  });

  it('列表把网关日志放入被动观测被测智能体区，不混入主动被测对象', async () => {
    apiMock.list.mockResolvedValue({
      items: [
        {
          id: 'model-1',
          name: 'qwen2.5 网关模型',
          targetType: 'MODEL',
          provider: 'newapi-gateway',
          model: 'qwen2.5',
          baseUrl: 'http://gateway-core:8080/v1',
          apiKeyMasked: 'sk****abcd', // pragma: allowlist secret
          hasApiKey: true,
          extraHeaders: null,
          defaultParams: null,
          accessConfig: null,
          isGlobal: true,
          isActive: true,
          lastTestStatus: null,
          lastTestedAt: null,
          createdAt: '2026-06-10T00:00:00.000Z',
          updatedAt: '2026-06-10T00:00:00.000Z',
          createdBy: null,
        },
        {
          id: 'gateway-1',
          name: 'NewAPI Gateway Logs (qwen2.5)',
          targetType: 'GATEWAY_LOG',
          provider: 'newapi-agent-security-gateway',
          model: 'gateway-log-source',
          baseUrl: 'http://control-plane:8081',
          apiKeyMasked: '',
          hasApiKey: false,
          extraHeaders: null,
          defaultParams: null,
          accessConfig: { gatewayBaseUrl: 'http://control-plane:8081' },
          isGlobal: true,
          isActive: true,
          lastTestStatus: null,
          lastTestedAt: null,
          createdAt: '2026-06-10T00:00:00.000Z',
          updatedAt: '2026-06-10T00:00:00.000Z',
          createdBy: null,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    });

    renderPage();

    const targetList = await screen.findByRole('region', {
      name: '评估对象列表',
    });
    expect(within(targetList).getByText('qwen2.5 网关模型')).toBeInTheDocument();
    expect(within(targetList).queryByText('NewAPI Gateway Logs (qwen2.5)')).not.toBeInTheDocument();

    const evidenceList = screen.getByRole('region', { name: '流量观测对象列表' });
    expect(within(evidenceList).getByText('NewAPI Gateway Logs (qwen2.5)')).toBeInTheDocument();
  });

  it('网关日志源可以发起日志分析并跳转到生成的评估任务', async () => {
    apiMock.list.mockResolvedValue({
      items: [
        {
          id: 'target-gateway-1',
          name: 'OpenClaw 生产 Agent 网关',
          targetType: 'GATEWAY_LOG',
          provider: 'newapi-agent-security-gateway',
          baseUrl: 'https://agent-gw.example.com/admin/v1',
          model: 'gateway-log-source',
          apiKeyMasked: '',
          hasApiKey: false,
          extraHeaders: null,
          defaultParams: null,
          accessConfig: {
            controlPlaneBaseUrl: 'https://agent-gw.example.com/admin/v1',
            tenantId: 'tenant-a',
          },
          isGlobal: true,
          isActive: true,
          lastTestedAt: null,
          lastTestStatus: null,
          createdAt: '2026-06-10T00:00:00.000Z',
          updatedAt: '2026-06-10T00:00:00.000Z',
          createdBy: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /分析日志/ }));
    expect(await screen.findByText('分析网关日志')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /开始分析/ }));

    await waitFor(() => expect(apiMock.analyzeGatewayLogs).toHaveBeenCalledTimes(1));
    expect(apiMock.analyzeGatewayLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        modelTargetId: 'target-gateway-1',
        startTime: expect.any(String),
        endTime: expect.any(String),
      }),
    );
    expect(await screen.findByText('任务详情页')).toBeInTheDocument();
  });

  it('分析网关日志时填写调用方 Key 与源 IP 会随分析请求一并下发', async () => {
    apiMock.list.mockResolvedValue({
      items: [
        {
          id: 'target-gateway-1',
          name: 'OpenClaw 生产 Agent 网关',
          targetType: 'GATEWAY_LOG',
          provider: 'newapi-agent-security-gateway',
          baseUrl: 'https://agent-gw.example.com/admin/v1',
          model: 'gateway-log-source',
          apiKeyMasked: '',
          hasApiKey: false,
          extraHeaders: null,
          defaultParams: null,
          accessConfig: {
            controlPlaneBaseUrl: 'https://agent-gw.example.com/admin/v1',
            tenantId: 'tenant-a',
          },
          isGlobal: true,
          isActive: true,
          lastTestedAt: null,
          lastTestStatus: null,
          createdAt: '2026-06-10T00:00:00.000Z',
          updatedAt: '2026-06-10T00:00:00.000Z',
          createdBy: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /分析日志/ }));
    expect(await screen.findByText('分析网关日志')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('留空表示不限调用方'), 'sk-customer-001');
    await userEvent.type(screen.getByPlaceholderText('留空表示不限源 IP'), '203.0.113.7');

    await userEvent.click(screen.getByRole('button', { name: /开始分析/ }));

    await waitFor(() => expect(apiMock.analyzeGatewayLogs).toHaveBeenCalledTimes(1));
    expect(apiMock.analyzeGatewayLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        modelTargetId: 'target-gateway-1',
        clientId: 'sk-customer-001',
        sourceIp: '203.0.113.7',
      }),
    );
  });

  it('删除被引用对象时弹窗列出引用任务，RUNNING 行禁用删除', async () => {
    apiMock.list.mockResolvedValue({
      items: [
        {
          id: 'target-x',
          name: 'BoFlow-qwen',
          targetType: 'MODEL',
          provider: 'openai',
          model: 'qwen3.6-plus',
          baseUrl: 'https://api.example.com',
          lastTestStatus: 'SUCCESS',
          lastTestedAt: '2026-06-10T00:00:00.000Z',
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    apiMock.evalTasksList.mockResolvedValue({
      items: [
        {
          id: 'task-1',
          name: '注入评估',
          status: 'COMPLETED',
          createdAt: '2026-06-11T00:00:00.000Z',
          resultCount: 12,
        },
        {
          id: 'task-2',
          name: '运行中评估',
          status: 'RUNNING',
          createdAt: '2026-06-12T00:00:00.000Z',
          resultCount: 3,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 100,
    });

    renderPage();

    const deleteButton = await screen.findByRole('button', { name: '删除' });
    await userEvent.click(deleteButton);

    expect(
      await screen.findByText(/无法直接删除.*BoFlow-qwen.*被以下评估任务引用/),
    ).toBeInTheDocument();
    expect(apiMock.evalTasksList).toHaveBeenCalledWith(
      expect.objectContaining({ modelTargetId: 'target-x', pageSize: 100 }),
    );
    expect(screen.getByText('注入评估')).toBeInTheDocument();
    expect(screen.getByText('运行中评估')).toBeInTheDocument();

    const runningRow = screen.getByText('运行中评估').closest('tr')!;
    expect(within(runningRow).getByRole('button', { name: '删除' })).toBeDisabled();
  });

  it('逐项删除引用任务，列表归零后自动删除对象一次', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiMock.list.mockResolvedValue({
      items: [
        {
          id: 'target-x',
          name: 'BoFlow-qwen',
          targetType: 'MODEL',
          provider: 'openai',
          model: 'qwen3.6-plus',
          baseUrl: 'https://api.example.com',
          lastTestStatus: 'SUCCESS',
          lastTestedAt: '2026-06-10T00:00:00.000Z',
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    apiMock.evalTasksList
      .mockResolvedValueOnce({
        items: [
          {
            id: 'task-1',
            name: '注入评估',
            status: 'COMPLETED',
            createdAt: '2026-06-11T00:00:00.000Z',
            resultCount: 12,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      })
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    apiMock.remove.mockResolvedValue(undefined);

    renderPage();

    const deleteButton = await screen.findByRole('button', { name: '删除' });
    await userEvent.click(deleteButton);

    const taskRow = (await screen.findByText('注入评估')).closest('tr')!;
    await userEvent.click(within(taskRow).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(apiMock.evalTasksRemove).toHaveBeenCalledWith('task-1'));
    await waitFor(() => expect(apiMock.remove).toHaveBeenCalledWith('target-x'));
    expect(apiMock.remove).toHaveBeenCalledTimes(1);
  });

  it('自动收尾删除对象失败时显示重试按钮，点击后重试成功', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiMock.list.mockResolvedValue({
      items: [
        {
          id: 'target-x',
          name: 'BoFlow-qwen',
          targetType: 'MODEL',
          provider: 'openai',
          model: 'qwen3.6-plus',
          baseUrl: 'https://api.example.com',
          lastTestStatus: 'SUCCESS',
          lastTestedAt: '2026-06-10T00:00:00.000Z',
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    apiMock.evalTasksList
      .mockResolvedValueOnce({
        items: [
          {
            id: 'task-1',
            name: '注入评估',
            status: 'COMPLETED',
            createdAt: '2026-06-11T00:00:00.000Z',
            resultCount: 12,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      })
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    // 第一次自动收尾删对象失败，第二次（重试）成功
    apiMock.remove.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);

    renderPage();

    const deleteButton = await screen.findByRole('button', { name: '删除' });
    await userEvent.click(deleteButton);

    // 删除引用任务
    const taskRow = (await screen.findByText('注入评估')).closest('tr')!;
    await userEvent.click(within(taskRow).getByRole('button', { name: '删除' }));

    // 等待自动收尾触发并失败，重试按钮出现
    const retryBtn = await screen.findByRole('button', { name: '重试删除' });
    expect(retryBtn).toBeInTheDocument();

    // 点击重试
    await userEvent.click(retryBtn);

    // 重试成功后 remove 共调用 2 次（第 1 次自动失败，第 2 次重试成功）
    await waitFor(() => expect(apiMock.remove).toHaveBeenCalledTimes(2));
    expect(apiMock.remove).toHaveBeenCalledWith('target-x');
  });

  describe('连同任务一起删除', () => {
    const referenced = () => {
      apiMock.list.mockResolvedValue({
        items: [{ id: 'target-x', name: 'BoFlow-qwen', targetType: 'MODEL', provider: 'openai', model: 'qwen3.6-plus',
          baseUrl: 'https://api.example.com', lastTestStatus: 'SUCCESS', lastTestedAt: '2026-06-10T00:00:00.000Z',
          createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' }],
        total: 1, page: 1, pageSize: 10,
      });
      apiMock.evalTasksList.mockResolvedValue({
        items: [
          { id: 'task-1', name: '注入评估', status: 'COMPLETED', createdAt: '2026-06-11T00:00:00.000Z', resultCount: 12 },
          { id: 'task-2', name: '越狱评估', status: 'COMPLETED', createdAt: '2026-06-12T00:00:00.000Z', resultCount: 3 },
        ],
        total: 2, page: 1, pageSize: 100,
      });
      apiMock.remove.mockResolvedValue(undefined);
    };
    const openDialog = async () => {
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: '删除' }));
      await screen.findByText(/被以下评估任务引用/);
    };

    it('确认框写明同时删除的任务数量和不可恢复，确认后带 withTasks 删除', async () => {
      referenced();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await openDialog();
      await userEvent.click(screen.getByRole('button', { name: '连同任务一起删除' }));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('同时删除 2 个评估任务及其结果和报告，不可恢复'));
      await waitFor(() => expect(apiMock.remove).toHaveBeenCalledWith('target-x', { withTasks: true }));
      expect(apiMock.evalTasksRemove).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByText(/被以下评估任务引用/)).not.toBeInTheDocument());
    });

    it('确认框里取消就什么都不删', async () => {
      referenced();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      await openDialog();
      await userEvent.click(screen.getByRole('button', { name: '连同任务一起删除' }));
      expect(apiMock.remove).not.toHaveBeenCalled();
      expect(screen.getByText('注入评估')).toBeInTheDocument();
    });

    it('没有评估任务删除权限时不提供这个入口', async () => {
      referenced();
      authState.denied.add('eval_task:delete');
      await openDialog();
      expect(screen.queryByRole('button', { name: '连同任务一起删除' })).not.toBeInTheDocument();
    });

    it('没有引用的对象照旧直接删除，不带 withTasks', async () => {
      referenced();
      apiMock.evalTasksList.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: '删除' }));
      await waitFor(() => expect(apiMock.remove).toHaveBeenCalledWith('target-x'));
      expect(apiMock.remove).toHaveBeenCalledTimes(1);
    });
  });
});
