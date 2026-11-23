import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, type ModelTarget } from '@/lib/api';
import { ToastProvider } from '@/components/ui/toast';
import { SettingsPage } from './SettingsPage';

const settingsAuth = vi.hoisted(() => ({ roles: ['admin'] }));
const apiMock = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsUpdate: vi.fn(),
  testGateway: vi.fn(),
  targetsList: vi.fn(),
  targetsCreate: vi.fn(),
  targetsUpdate: vi.fn(),
  targetsTest: vi.fn(),
  targetsTestConfig: vi.fn(),
  scopePolicies: vi.fn(),
  previewScopePolicy: vi.fn(),
  saveScopePolicies: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, _status: number) {
      super(message);
    }
  },
  api: {
    systemSettings: {
      get: apiMock.settingsGet,
      update: apiMock.settingsUpdate,
      testGateway: apiMock.testGateway,
    },
    modelTargets: {
      list: apiMock.targetsList,
      create: apiMock.targetsCreate,
      update: apiMock.targetsUpdate,
      test: apiMock.targetsTest,
      testConfig: apiMock.targetsTestConfig,
    },
    serviceAssurance: {
      scopePolicies: apiMock.scopePolicies,
      previewScopePolicy: apiMock.previewScopePolicy,
      saveScopePolicies: apiMock.saveScopePolicies,
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: () => true, user: { roles: settingsAuth.roles } }),
}));

const ACCESS = {
  encryptedLoginUrl: 'https://eval.example.com/secure',
  compatibleLoginUrl: 'https://eval.example.com/login',
  loginPolicy: 'PASSWORD',
  sessionPolicy: 'STRICT',
};

function settingsPayload() {
  return {
    access: { ...ACCESS },
    audit: {
      operationAudit: true,
      evidenceRetention: 'FULL',
      logRedaction: 'MASKED',
      retentionDays: 180,
      externalArchive: false,
      archiveTarget: '',
    },
    gateway: {
      gatewayBaseUrl: 'https://gateway.example.com',
      gatewayLinkageEnabled: true,
      secretConfigured: true,
      addressAuthorization: 'AUTHORIZED' as const,
    },
    redteam: {
      gatewayTargetId: '',
      attackerTargetId: '',
      secondaryAttackerTargetId: '',
      judgeTargetId: '',
      breakOn: 'verdict' as const,
      maxRounds: 6,
      noProgressK: 2,
      moves: [],
    },
    agent_eval: {
      attackerTargetId: '',
      judgeTargetId: '',
      adaptiveRounds: 3,
      noProgressK: 2,
      enabled: false,
      fanoutEnabled: false,
    },
    updatedAt: {
      access: '2026-08-01T00:00:00.000Z',
      audit: '2026-08-01T00:00:00.000Z',
      gateway: '2026-08-01T00:00:00.000Z',
      redteam: null,
      agent_eval: null,
    },
  };
}

function renderPage(
  initialEntries: string[] = ['/settings'],
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <SettingsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function judgeTarget(overrides: Partial<ModelTarget> = {}): ModelTarget {
  return {
    id: 'judge-1',
    name: 'AI复核',
    targetType: 'JUDGE',
    provider: 'openai-compatible',
    baseUrl: 'https://judge.example.com/v1',
    model: 'judge-model',
    apiKeyMasked: '****',
    hasApiKey: true,
    extraHeaders: null,
    defaultParams: null,
    accessConfig: null,
    isGlobal: true,
    isActive: true,
    lastTestedAt: null,
    lastTestStatus: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdBy: null,
    ...overrides,
  };
}

function listWithJudge(target: ModelTarget) {
  return { items: [target], total: 1, page: 1, pageSize: 200 };
}

const SUCCESSFUL_TEST = {
  status: 'SUCCESS',
  latencyMs: 100,
  httpStatus: 200,
  model: 'judge-model',
  sample: 'ok',
  usage: null,
  error: null,
};

describe('SettingsPage 分区表单互不干扰', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.settingsGet.mockResolvedValue(settingsPayload());
    // 服务端始终回全量配置：未提交的分区回的是已存值，这正是覆盖未保存编辑的来源。
    apiMock.settingsUpdate.mockImplementation(async (body: Record<string, unknown>) => {
      const next = settingsPayload();
      if (body.access) Object.assign(next.access, body.access);
      if (body.audit) Object.assign(next.audit, body.audit);
      if (body.gateway) Object.assign(next.gateway, body.gateway);
      return next;
    });
    apiMock.targetsList.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
    apiMock.scopePolicies.mockResolvedValue({
      policies: [],
      defaultPolicyRef: null,
      managedByPlatform: true,
      updatedAt: null,
    });
    apiMock.previewScopePolicy.mockResolvedValue({
      origin: 'https://api.example.test',
      hostname: 'api.example.test',
      addresses: ['93.184.216.34'],
      suggestedCidrs: ['93.184.216.34/32'],
      allowPrivate: false,
      allowPublic: true,
    });
    apiMock.saveScopePolicies.mockImplementation(async (policies) => ({
      policies,
      defaultPolicyRef: policies[0]?.ref ?? null,
      managedByPlatform: true,
      updatedAt: '2026-09-01T00:00:00.000Z',
    }));
  });

  it('无入口地址时显示未配置及填写引导', async () => {
    const payload = settingsPayload();
    payload.access.encryptedLoginUrl = '';
    payload.access.compatibleLoginUrl = '';
    apiMock.settingsGet.mockResolvedValue(payload);
    renderPage();
    expect(await screen.findByText('未配置，请填写实际访问地址')).toBeInTheDocument();
    expect(screen.getByText('未配置')).toBeInTheDocument();
    expect(screen.getByLabelText('加密访问入口')).toHaveValue('');
    expect(
      within(document.getElementById('access-settings')!).queryByText('已启用'),
    ).not.toBeInTheDocument();
  });

  it('保存审计分区不会重置访问分区里未保存的编辑', async () => {
    const user = userEvent.setup();
    renderPage();

    const accessInput = await screen.findByLabelText('加密访问入口');
    await waitFor(() => expect(accessInput).toHaveValue(ACCESS.encryptedLoginUrl));

    // 在「访问与登录」改一处，先不保存
    await user.clear(accessInput);
    await user.type(accessInput, 'https://eval.example.com/changed');
    expect(accessInput).toHaveValue('https://eval.example.com/changed');

    // 去「审计与留存」改留存天数并保存
    await user.click(screen.getByRole('tab', { name: /审计与留存/ }));
    const retentionInput = screen.getByLabelText('留存天数');
    await user.clear(retentionInput);
    await user.type(retentionInput, '365');
    await user.click(screen.getByRole('button', { name: '保存审计与留存配置' }));

    await waitFor(() => expect(apiMock.settingsUpdate).toHaveBeenCalledTimes(1));
    const sent = apiMock.settingsUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toBeTruthy();
    expect(sent.audit).toBeTruthy();
    expect(sent.access).toBeUndefined();

    // 关键断言：访问分区未保存的编辑必须还在
    await user.click(screen.getByRole('tab', { name: /访问与登录/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('加密访问入口')).toHaveValue('https://eval.example.com/changed'),
    );
    // 审计分区自己的编辑已保存并回填
    await user.click(screen.getByRole('tab', { name: /审计与留存/ }));
    expect(screen.getByLabelText('留存天数')).toHaveValue(365);
  });

  it('保存访问分区不会重置网关分区里未保存的编辑', async () => {
    const user = userEvent.setup();
    renderPage();

    const gatewayInput = await screen.findByLabelText('网关控制台地址');
    await waitFor(() => expect(gatewayInput).toHaveValue('https://gateway.example.com'));

    await user.clear(gatewayInput);
    await user.type(gatewayInput, 'https://gateway.example.com/new');

    const accessInput = screen.getByLabelText('兼容访问入口');
    await user.clear(accessInput);
    await user.type(accessInput, 'https://eval.example.com/other');
    await user.click(screen.getByRole('button', { name: '保存访问与登录配置' }));

    await waitFor(() => expect(apiMock.settingsUpdate).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(screen.getByLabelText('网关控制台地址')).toHaveValue(
        'https://gateway.example.com/new',
      ),
    );
  });

  it('四个保存按钮各有可区分的无障碍名称', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('加密访问入口');

    expect(screen.getByRole('button', { name: '保存访问与登录配置' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /审计与留存/ }));
    expect(screen.getByRole('button', { name: '保存审计与留存配置' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /网关联动/ }));
    expect(screen.getByRole('button', { name: '保存网关联动配置' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /独立判定模型/ }));
    expect(screen.getByRole('button', { name: '保存判定模型配置' })).toBeInTheDocument();
  });

  it('用响应式分类导航承载七个常驻设置面板', async () => {
    renderPage();
    await screen.findByLabelText('加密访问入口');

    const settingsRegion = screen.getByRole('region', { name: '平台配置' });
    // 页面不再自带 max-w-7xl/mx-auto 居中，页头与面包屑左缘对齐（宽度由外壳统一约束）。
    expect(settingsRegion).not.toHaveClass('max-w-7xl');
    expect(settingsRegion).not.toHaveClass('mx-auto');
    expect(screen.getByRole('heading', { level: 1, name: '平台设置' })).toBeInTheDocument();

    const tablist = screen.getByRole('tablist', { name: '平台设置分类' });
    expect(tablist).toHaveClass('overflow-x-auto', 'lg:flex-col');

    for (const title of [
      '访问与登录',
      '审计与留存',
      '网关联动',
      '服务核验授权范围',
      '独立判定模型',
      '授权许可',
      '对抗评估配置',
      '安全设置',
      '平台品牌',
      '配置管理',
      '数据安全',
    ]) {
      expect(screen.getByRole('tab', { name: new RegExp(title) })).toBeInTheDocument();
    }

    expect(screen.getAllByRole('tab')).toHaveLength(11);
    expect(screen.getByRole('tab', { name: /访问与登录/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(document.getElementById('settings-panel-access')).not.toHaveAttribute('hidden');
    expect(document.getElementById('settings-panel-audit')).toHaveAttribute('hidden');
    expect(document.getElementById('settings-panel-gateway')).toHaveAttribute('hidden');
    expect(document.getElementById('settings-panel-scope')).toHaveAttribute('hidden');
    expect(document.getElementById('settings-panel-review')).toHaveAttribute('hidden');
    expect(document.getElementById('settings-panel-license')).toHaveAttribute('hidden');
    expect(document.getElementById('settings-panel-redteam')).toHaveAttribute('hidden');
  });

  it('切换分类后保留其他面板的未保存编辑', async () => {
    const user = userEvent.setup();
    renderPage();

    const accessInput = await screen.findByLabelText('加密访问入口');
    await user.clear(accessInput);
    await user.type(accessInput, 'https://eval.example.com/draft');

    await user.click(screen.getByRole('tab', { name: /审计与留存/ }));
    expect(screen.getByRole('tab', { name: /审计与留存/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(document.getElementById('settings-panel-access')).toHaveAttribute('hidden');
    expect(document.getElementById('settings-panel-audit')).not.toHaveAttribute('hidden');

    await user.click(screen.getByRole('tab', { name: /访问与登录/ }));
    expect(screen.getByLabelText('加密访问入口')).toHaveValue('https://eval.example.com/draft');
  });

  it('安全设置分区可配置密码策略、非法登录锁定与超时登出并保存', async () => {
    const user = userEvent.setup();
    renderPage(['/settings#security-settings']);
    const minLen = await screen.findByLabelText('密码长度（位）');
    expect(screen.getByLabelText('密码强制更新时间（天）')).toBeInTheDocument();
    expect(screen.getByLabelText('最大非法登录次数（次）')).toBeInTheDocument();
    expect(screen.getByLabelText('超过最大次数后禁用账户时间（分钟）')).toBeInTheDocument();
    expect(screen.getByLabelText('超时登出时间（分钟）')).toBeInTheDocument();
    await user.clear(minLen);
    await user.type(minLen, '12');
    await user.click(screen.getByLabelText('包含特殊字符'));
    await user.click(screen.getByRole('button', { name: '保存安全设置' }));
    await waitFor(() =>
      expect(apiMock.settingsUpdate).toHaveBeenCalledWith({
        security: expect.objectContaining({ passwordMinLength: 12, passwordRequireSpecial: true }),
      }),
    );
  });

  it('安全设置可把操作日志查看范围改为仅平台管理员', async () => {
    const user = userEvent.setup();
    renderPage(['/settings#security-settings']);
    const scope = await screen.findByLabelText('操作日志查看范围');
    expect(scope).toHaveValue('admins_and_auditors');
    expect(within(scope).getByRole('option', { name: '管理员和审计员' })).toBeInTheDocument();
    await user.selectOptions(scope, '仅平台管理员');
    await user.click(screen.getByRole('button', { name: '保存安全设置' }));
    await waitFor(() =>
      expect(apiMock.settingsUpdate).toHaveBeenCalledWith({
        security: expect.objectContaining({ auditLogAccess: 'system_admin_only' }),
      }),
    );
  });

  it('平台品牌可填写支持单位和联系人并保存', async () => {
    const user = userEvent.setup();
    renderPage(['/settings#tenant-settings']);
    await user.type(await screen.findByLabelText('支持单位'), '国家管网信息中心');
    expect(
      screen.queryByText('配置平台 logo、页签 logo、平台标题和技术支持联系方式。'),
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('联系人'), '张工');
    await user.type(screen.getByLabelText('联系电话'), '010-12345678');
    await user.type(screen.getByLabelText('联系邮箱'), 'support@example.com');
    await user.click(screen.getByRole('button', { name: '保存平台品牌' }));
    await waitFor(() =>
      expect(apiMock.settingsUpdate).toHaveBeenCalledWith({
        tenant: expect.objectContaining({
          supportOrg: '国家管网信息中心',
          contactName: '张工',
          contactPhone: '010-12345678',
          contactEmail: 'support@example.com',
        }),
      }),
    );
  });

  it('根据 URL 锚点直接打开独立判定模型', async () => {
    renderPage(['/settings#independent-judge-model']);
    await screen.findByLabelText('接口地址');

    expect(screen.getByRole('tab', { name: /独立判定模型/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(document.getElementById('settings-panel-access')).toHaveAttribute('hidden');
    expect(document.getElementById('settings-panel-review')).not.toHaveAttribute('hidden');
  });

  it('支持方向键在分类间循环切换焦点和面板', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('加密访问入口');

    const accessTab = screen.getByRole('tab', { name: /访问与登录/ });
    accessTab.focus();
    await user.keyboard('{ArrowDown}');

    const auditTab = screen.getByRole('tab', { name: /审计与留存/ });
    expect(auditTab).toHaveFocus();
    expect(auditTab).toHaveAttribute('aria-selected', 'true');
    expect(document.getElementById('settings-panel-audit')).not.toHaveAttribute('hidden');
  });

  it('管理员可解析目标并保存为服务核验授权范围', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('加密访问入口');
    await user.click(screen.getByRole('tab', { name: /服务核验授权范围/ }));
    const targetInput = screen.getByLabelText('目标地址');
    await user.type(targetInput, 'https://api.example.test/v1');
    await user.type(screen.getByLabelText('授权名称'), '生产模型 API');
    await user.click(screen.getByRole('button', { name: '解析并检查' }));
    expect(await screen.findByText('授权源：https://api.example.test')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '加入待保存范围' }));
    expect(screen.getByText('有未保存的变更')).toBeInTheDocument();
    expect(screen.queryByText('已授权 1 个目标')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存授权范围' }));

    await waitFor(() =>
      expect(apiMock.saveScopePolicies).toHaveBeenCalledWith([
        expect.objectContaining({
          name: '生产模型 API',
          origins: ['https://api.example.test'],
          cidrs: ['93.184.216.34/32'],
          isDefault: true,
        }),
      ]),
    );
  });
  it.each([
    ['接口地址', 'https://changed.example.com/v1'],
    ['模型名称', 'changed-model'],
  ])('修改%s但密钥留空时先提示保存，不测试旧配置', async (label, value) => {
    const user = userEvent.setup();
    apiMock.targetsList.mockResolvedValue(listWithJudge(judgeTarget()));
    renderPage(['/settings#independent-judge-model']);
    const input = await screen.findByLabelText(label);
    await waitFor(() => expect(screen.getByLabelText('模型名称')).toHaveValue('judge-model'));
    await user.clear(input);
    await user.type(input, value);

    expect(screen.getByText(/使用已保存的密钥测试前，请先保存配置/)).toBeVisible();
    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
    expect(apiMock.targetsTest).not.toHaveBeenCalled();
    expect(apiMock.targetsTestConfig).not.toHaveBeenCalled();
    expect(apiMock.targetsUpdate).not.toHaveBeenCalled();
  });

  it('保存改动后使用保存的配置测试，并刷新其他页面的模型候选缓存', async () => {
    const user = userEvent.setup();
    const target = judgeTarget({
      lastTestStatus: 'SUCCESS',
      lastTestedAt: '2026-09-01T00:00:00.000Z',
    });
    const changed = judgeTarget({ model: 'changed-model' });
    apiMock.targetsList.mockResolvedValue(listWithJudge(target));
    apiMock.targetsUpdate.mockResolvedValue(changed);
    apiMock.targetsTest.mockResolvedValue(SUCCESSFUL_TEST);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['model-targets', 'redteam-eval'], listWithJudge(target));
    queryClient.setQueryData(['model-targets', 'redteam-selectors'], listWithJudge(target));
    renderPage(['/settings#independent-judge-model'], queryClient);
    const input = await screen.findByLabelText('模型名称');
    await waitFor(() => expect(input).toHaveValue('judge-model'));
    await user.clear(input);
    await user.type(input, 'changed-model');
    apiMock.targetsList.mockResolvedValue(listWithJudge(changed));
    await user.click(screen.getByRole('button', { name: '保存判定模型配置' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled());
    expect(apiMock.targetsUpdate).toHaveBeenCalledWith(
      'judge-1',
      expect.objectContaining({ model: 'changed-model' }),
    );
    expect(apiMock.targetsUpdate.mock.calls[0]?.[1]).not.toHaveProperty('apiKey');
    expect(input).toHaveValue('changed-model');
    expect(screen.getByLabelText('访问密钥')).toHaveValue('');
    expect(screen.getByText('已保存')).toBeVisible();
    expect(screen.getByText(/配置已变更，请重新测试/)).toBeVisible();
    expect(queryClient.getQueryState(['model-targets', 'redteam-eval'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['model-targets', 'redteam-selectors'])?.isInvalidated).toBe(
      true,
    );

    queryClient.setQueryData(['model-targets', 'redteam-eval'], listWithJudge(changed));
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(apiMock.targetsTest).toHaveBeenCalledWith('judge-1'));
    await waitFor(() =>
      expect(queryClient.getQueryState(['model-targets', 'redteam-eval'])?.isInvalidated).toBe(
        true,
      ),
    );
    expect(apiMock.targetsTestConfig).not.toHaveBeenCalled();
  });

  it('有多个独立模型时保存仍保留当前模型的位置，不切换到另一个模型', async () => {
    const user = userEvent.setup();
    const original = judgeTarget();
    const another = judgeTarget({ id: 'judge-2', model: 'another-model' });
    const changed = judgeTarget({ model: 'saved-model' });
    apiMock.targetsList
      .mockResolvedValueOnce({
        items: [original, another],
        total: 2,
        page: 1,
        pageSize: 200,
      })
      .mockImplementation(() => new Promise(() => {}));
    apiMock.targetsUpdate.mockResolvedValue(changed);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(['/settings#independent-judge-model'], queryClient);
    await waitFor(() => expect(screen.getByLabelText('模型名称')).toHaveValue('judge-model'));
    await user.clear(screen.getByLabelText('模型名称'));
    await user.type(screen.getByLabelText('模型名称'), 'saved-model');
    await user.click(screen.getByRole('button', { name: '保存判定模型配置' }));
    await waitFor(() =>
      expect(
        queryClient.getQueryData<{ items: ModelTarget[] }>(['system-review-model'])?.items[0]
          ?.model,
      ).toBe('saved-model'),
    );
    expect(screen.getByLabelText('模型名称')).toHaveValue('saved-model');
  });

  it('连接失败详情在自动刷新和手动刷新后仍然可见', async () => {
    const user = userEvent.setup();
    apiMock.targetsList.mockResolvedValue(listWithJudge(judgeTarget()));
    apiMock.targetsTest.mockResolvedValue({
      ...SUCCESSFUL_TEST,
      status: 'FAILED',
      httpStatus: 401,
      error: '访问密钥无效（401）',
    });
    renderPage(['/settings#independent-judge-model']);
    await waitFor(() => expect(screen.getByLabelText('模型名称')).toHaveValue('judge-model'));
    apiMock.targetsList.mockResolvedValue(
      listWithJudge(
        judgeTarget({ lastTestStatus: 'FAILED', lastTestedAt: '2026-09-07T08:55:00.000Z' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(apiMock.targetsList).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert')).toHaveTextContent('判定模型连接失败：访问密钥无效（401）');
    expect(screen.getByText('已保存 · 测试失败')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(apiMock.targetsList).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('alert')).toHaveTextContent('访问密钥无效（401）');
  });

  it('刷新与临时配置测试不会覆盖未保存的字段和密钥，也不会偷偷保存', async () => {
    const user = userEvent.setup();
    apiMock.targetsList.mockResolvedValue(listWithJudge(judgeTarget()));
    apiMock.targetsTestConfig.mockResolvedValue({
      ...SUCCESSFUL_TEST,
      status: 'FAILED',
      error: '模型不存在',
    });
    renderPage(['/settings#independent-judge-model']);
    const input = await screen.findByLabelText('模型名称');
    await waitFor(() => expect(input).toHaveValue('judge-model'));
    await user.clear(input);
    await user.type(input, 'draft-model');
    await user.type(screen.getByLabelText('访问密钥'), 'test-only-key');
    apiMock.targetsList.mockResolvedValue(
      listWithJudge(judgeTarget({ updatedAt: '2026-09-07T09:00:00.000Z' })),
    );
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(apiMock.targetsList).toHaveBeenCalledTimes(2));
    expect(input).toHaveValue('draft-model');
    expect(screen.getByLabelText('访问密钥')).toHaveValue('test-only-key');
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(apiMock.targetsList).toHaveBeenCalledTimes(3));

    expect(apiMock.targetsTestConfig).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'draft-model', apiKey: 'test-only-key' }),
    );
    expect(apiMock.targetsTest).not.toHaveBeenCalled();
    expect(apiMock.targetsUpdate).not.toHaveBeenCalled();
    expect(apiMock.targetsCreate).not.toHaveBeenCalled();
    expect(input).toHaveValue('draft-model');
    expect(screen.getByLabelText('访问密钥')).toHaveValue('test-only-key');
    expect(screen.getByRole('alert')).toHaveTextContent('模型不存在');
    expect(screen.getByText('有未保存的变更')).toBeVisible();
    expect(screen.getByText(/未保存配置测试：失败/)).toBeVisible();
  });

  it('请求异常在卡片中保留可读错误，停用配置不显示为可用', async () => {
    const user = userEvent.setup();
    apiMock.targetsList.mockResolvedValue(
      listWithJudge(judgeTarget({ isActive: false, lastTestStatus: 'SUCCESS' })),
    );
    apiMock.targetsTest.mockRejectedValue(new ApiError('测试服务暂不可用', 502));
    renderPage(['/settings#independent-judge-model']);
    await waitFor(() => expect(screen.getByLabelText('模型名称')).toHaveValue('judge-model'));
    expect(screen.getByText('已停用')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('测试服务暂不可用');
    expect(screen.getByText('最近测试：失败')).toBeVisible();
  });
  it.each([
    ['对象', { id: 'replacement-judge' }],
    ['接口地址', { baseUrl: 'https://replacement.example.com/v1' }],
    ['模型名称', { model: 'replacement-model' }],
    ['提供方', { provider: 'another-provider' }],
    ['密钥', { apiKeyMasked: '****5678' }],
    ['密钥删除', { hasApiKey: false }],
    ['请求头', { extraHeaders: { 'X-Test': 'replacement' } }],
    ['默认参数', { defaultParams: { temperature: 0 } }],
    ['接入配置', { accessConfig: { endpoint: '/another-endpoint' } }],
    ['测试状态重置', { lastTestStatus: null, lastTestedAt: null }],
  ] satisfies Array<[string, Partial<ModelTarget>]>)(
    '外部修改%s后清除旧测试结果，显示新配置状态',
    async (_label, change) => {
      const user = userEvent.setup();
      const target = judgeTarget({
        lastTestStatus: 'FAILED',
        lastTestedAt: '2026-09-07T08:55:00.000Z',
      });
      apiMock.targetsList.mockResolvedValue(listWithJudge(target));
      apiMock.targetsTest.mockResolvedValue({
        ...SUCCESSFUL_TEST,
        status: 'FAILED',
        error: '旧配置连接失败',
      });
      renderPage(['/settings#independent-judge-model']);
      await waitFor(() => expect(screen.getByLabelText('模型名称')).toHaveValue('judge-model'));
      await user.click(screen.getByRole('button', { name: '测试连接' }));
      await waitFor(() => expect(apiMock.targetsList).toHaveBeenCalledTimes(2));
      expect(screen.getByRole('alert')).toHaveTextContent('旧配置连接失败');

      const replacement = judgeTarget({ ...target, lastTestStatus: 'SUCCESS', ...change });
      apiMock.targetsList.mockResolvedValue(listWithJudge(replacement));
      await user.click(screen.getByRole('button', { name: '刷新' }));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(screen.getByLabelText('模型名称')).toHaveValue(replacement.model);
      expect(screen.getByLabelText('接口地址')).toHaveValue(replacement.baseUrl);
      expect(
        screen.getByText(replacement.lastTestStatus ? /最近测试：成功/ : '最近测试：未测试'),
      ).toBeVisible();
    },
  );

  it('相同连接只改变更新时间和 JSON 字段顺序时保留当前测试失败详情', async () => {
    const user = userEvent.setup();
    const target = judgeTarget({ extraHeaders: { 'X-First': 'one', 'X-Second': 'two' } });
    apiMock.targetsList.mockResolvedValue(listWithJudge(target));
    apiMock.targetsTest.mockResolvedValue({
      ...SUCCESSFUL_TEST,
      status: 'FAILED',
      error: '当前连接失败',
    });
    renderPage(['/settings#independent-judge-model']);
    await waitFor(() => expect(screen.getByLabelText('模型名称')).toHaveValue('judge-model'));
    apiMock.targetsList.mockResolvedValue(
      listWithJudge({
        ...target,
        lastTestStatus: 'FAILED',
        lastTestedAt: '2026-09-07T08:55:00.000Z',
        updatedAt: '2026-09-07T08:55:00.000Z',
        extraHeaders: { 'X-Second': 'two', 'X-First': 'one' },
      }),
    );
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(apiMock.targetsList).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert')).toHaveTextContent('当前连接失败');
  });

  it('外部保存新配置时仍保留未保存草稿及其临时测试结果', async () => {
    const user = userEvent.setup();
    apiMock.targetsList.mockResolvedValue(listWithJudge(judgeTarget()));
    apiMock.targetsTestConfig.mockResolvedValue({
      ...SUCCESSFUL_TEST,
      status: 'FAILED',
      error: '草稿模型不存在',
    });
    renderPage(['/settings#independent-judge-model']);
    await waitFor(() => expect(screen.getByLabelText('模型名称')).toHaveValue('judge-model'));
    await user.clear(screen.getByLabelText('模型名称'));
    await user.type(screen.getByLabelText('模型名称'), 'draft-model');
    await user.type(screen.getByLabelText('访问密钥'), 'draft-only-key');
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(apiMock.targetsList).toHaveBeenCalledTimes(2));

    apiMock.targetsList.mockResolvedValue(
      listWithJudge(
        judgeTarget({ id: 'replacement', model: 'external-model', apiKeyMasked: '****5678' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(apiMock.targetsList).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText('模型名称')).toHaveValue('draft-model');
    expect(screen.getByLabelText('访问密钥')).toHaveValue('draft-only-key');
    expect(screen.getByRole('alert')).toHaveTextContent('草稿模型不存在');
    expect(screen.getByText(/未保存配置测试：失败/)).toBeVisible();
  });
});

it('管理员从平台设置二级入口进入 API 令牌', async () => {
  settingsAuth.roles = ['admin'];
  renderPage();
  expect(await screen.findByRole('link', { name: 'API 令牌' })).toHaveAttribute('href', '/settings/api-tokens');
});
it('审计员看不到平台设置里的 API 令牌入口', async () => {
  settingsAuth.roles = ['auditor'];
  renderPage();
  await screen.findByRole('heading', { name: '平台设置' });
  expect(screen.queryByRole('link', { name: 'API 令牌' })).not.toBeInTheDocument();
  settingsAuth.roles = ['admin'];
});
