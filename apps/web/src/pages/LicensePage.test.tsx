import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { LicensePage } from './LicensePage';
import { SettingsPage } from './SettingsPage';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  fingerprint: vi.fn(),
  hostInfo: vi.fn(),
  upload: vi.fn(),
  systemSettingsGet: vi.fn(),
  systemSettingsUpdate: vi.fn(),
  modelTargetsList: vi.fn(),
  modelTargetsCreate: vi.fn(),
  modelTargetsUpdate: vi.fn(),
  modelTargetsTest: vi.fn(),
  modelTargetsTestConfig: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    license: {
      get: apiMock.get,
      fingerprint: apiMock.fingerprint,
      hostInfo: apiMock.hostInfo,
      upload: apiMock.upload,
    },
    systemSettings: {
      get: apiMock.systemSettingsGet,
      update: apiMock.systemSettingsUpdate,
    },
    modelTargets: {
      list: apiMock.modelTargetsList,
      create: apiMock.modelTargetsCreate,
      update: apiMock.modelTargetsUpdate,
      test: apiMock.modelTargetsTest,
      testConfig: apiMock.modelTargetsTestConfig,
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

function renderPage(page: 'license' | 'settings' = 'license') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{page === 'settings' ? <SettingsPage /> : <LicensePage />}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function cardForHeading(heading: HTMLElement): HTMLElement {
  const card = heading.closest('.rounded-card');
  if (!(card instanceof HTMLElement)) throw new Error('未找到设置卡片容器');
  return card;
}

async function openSettingsSection(name: string): Promise<HTMLElement> {
  await screen.findByRole('heading', { name: '平台设置' });
  await userEvent.click(screen.getByRole('tab', { name: new RegExp(name) }));
  return cardForHeading(screen.getByRole('heading', { name }));
}

describe('LicensePage settings center', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.get.mockResolvedValue({
      configured: false,
      enforce: false,
      publicKeyConfigured: false,
      fingerprint: '0ea45dc8f8f580e0d8d41d7d69d9c14cc8d3d2d1e2fb39493c158f276e1c95db',
      license: null,
    });
    apiMock.fingerprint.mockResolvedValue({
      fingerprint: '0ea45dc8f8f580e0d8d41d7d69d9c14cc8d3d2d1e2fb39493c158f276e1c95db',
    });
    apiMock.hostInfo.mockResolvedValue({
      fingerprint: '0ea45dc8f8f580e0d8d41d7d69d9c14cc8d3d2d1e2fb39493c158f276e1c95db',
      hostname: 'lse-host-01',
      deploymentId: 'dep-abc',
    });
    apiMock.systemSettingsGet.mockResolvedValue({
      access: {
        encryptedLoginUrl: 'https://192.168.31.182:10443/login',
        compatibleLoginUrl: 'http://192.168.31.182:8090/login',
        loginPolicy: '保留兼容入口，引导使用加密入口',
        sessionPolicy: '签名会话令牌与权限校验',
      },
      audit: {
        operationAudit: true,
        evidenceRetention: '请求、响应与判定结果',
        logRedaction: '按规则脱敏',
        retentionDays: 180,
        externalArchive: false,
        archiveTarget: '',
      },
      gateway: {
        gatewayBaseUrl: 'http://control-plane:8081',
        gatewayLinkageEnabled: false,
        secretConfigured: true,
        addressAuthorization: 'AUTHORIZED',
      },
      updatedAt: { access: null, audit: null, gateway: null },
    });
    apiMock.systemSettingsUpdate.mockImplementation(async (body) => ({
      ...(await apiMock.systemSettingsGet()),
      ...body,
    }));
    apiMock.modelTargetsList.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
    apiMock.modelTargetsCreate.mockResolvedValue({ id: 'judge-1', name: 'AI复核' });
    apiMock.modelTargetsUpdate.mockImplementation(async (id, body) => {
      const current = await apiMock.modelTargetsList();
      const target = {
        ...current.items.find((item: { id: string }) => item.id === id),
        ...body,
        id,
      };
      apiMock.modelTargetsList.mockResolvedValue({ ...current, items: [target] });
      return target;
    });
    apiMock.modelTargetsTest.mockResolvedValue({
      status: 'SUCCESS',
      latencyMs: 120,
      httpStatus: 200,
      model: 'judge-model',
      sample: 'ok',
      usage: null,
      error: null,
    });
    apiMock.modelTargetsTestConfig.mockResolvedValue({
      status: 'SUCCESS',
      latencyMs: 100,
      httpStatus: 200,
      model: 'judge-model',
      sample: 'ok',
      usage: null,
      error: null,
    });
  });

  it('用分类导航呈现平台设置，不暴露内部部署字段', async () => {
    renderPage('settings');

    expect(await screen.findByRole('heading', { name: '平台设置' })).toBeInTheDocument();

    for (const name of [
      '访问与登录',
      '审计与留存',
      '网关联动',
      '服务核验授权范围',
      '独立判定模型',
    ]) {
      expect(await openSettingsSection(name)).toBeInTheDocument();
    }

    expect(screen.queryByText(/Agent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/后端/)).not.toBeInTheDocument();
    expect(screen.queryByText(/部署配置/)).not.toBeInTheDocument();
  });

  it('在审计与留存卡片中直接保存平台配置', async () => {
    renderPage('settings');

    const auditCard = await openSettingsSection('审计与留存');

    expect((within(auditCard).getByLabelText('证据留存范围') as HTMLSelectElement).value).toBe(
      '请求、响应与判定结果',
    );

    await userEvent.clear(within(auditCard).getByLabelText('留存天数'));
    await userEvent.type(within(auditCard).getByLabelText('留存天数'), '365');
    await userEvent.clear(within(auditCard).getByLabelText('归档位置'));
    await userEvent.type(within(auditCard).getByLabelText('归档位置'), '集团审计归档库');
    await userEvent.click(within(auditCard).getByLabelText('启用外部归档'));
    await userEvent.click(within(auditCard).getByRole('button', { name: '保存审计与留存配置' }));

    await waitFor(() => expect(apiMock.systemSettingsUpdate).toHaveBeenCalledTimes(1));
    expect(apiMock.systemSettingsUpdate).toHaveBeenCalledWith({
      audit: expect.objectContaining({
        retentionDays: 365,
        externalArchive: true,
        archiveTarget: '集团审计归档库',
      }),
    });
  });

  it('网关地址未获部署授权时在联动卡片中明确告警', async () => {
    const current = await apiMock.systemSettingsGet();
    apiMock.systemSettingsGet.mockResolvedValue({
      ...current,
      gateway: {
        ...current.gateway,
        addressAuthorization: 'NOT_AUTHORIZED',
      },
    });

    renderPage('settings');

    const gatewayCard = await openSettingsSection('网关联动');
    expect(within(gatewayCard).getByText(/当前网关地址未获部署授权/)).toBeInTheDocument();
  });

  it('在网关联动卡片中开启网关联动开关并保存', async () => {
    renderPage('settings');

    const gatewayCard = await openSettingsSection('网关联动');
    const toggle = within(gatewayCard).getByRole('checkbox', {
      name: /关联安全网关流量证据/,
    });
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);
    await userEvent.click(within(gatewayCard).getByRole('button', { name: '保存网关联动配置' }));

    await waitFor(() => expect(apiMock.systemSettingsUpdate).toHaveBeenCalledTimes(1));
    expect(apiMock.systemSettingsUpdate).toHaveBeenCalledWith({
      gateway: expect.objectContaining({ gatewayLinkageEnabled: true }),
    });
  });

  it('在独立判定模型卡片中配置和测试判定模型', async () => {
    apiMock.modelTargetsList.mockResolvedValue({
      items: [
        {
          id: 'judge-1',
          name: 'AI复核',
          targetType: 'JUDGE',
          provider: 'openai-compatible',
          baseUrl: 'https://judge.example.com/v1',
          model: 'judge-model-1',
          apiKeyMasked: 'sk****1234',
          hasApiKey: true,
          extraHeaders: null,
          defaultParams: null,
          accessConfig: null,
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
      pageSize: 200,
    });

    renderPage('settings');

    const reviewCard = await openSettingsSection('独立判定模型');
    expect(apiMock.modelTargetsList).toHaveBeenCalledWith(
      expect.objectContaining({ includeSystem: true, pageSize: 200 }),
    );

    expect(
      within(reviewCard).getByDisplayValue('https://judge.example.com/v1'),
    ).toBeInTheDocument();
    expect(within(reviewCard).getByDisplayValue('judge-model-1')).toBeInTheDocument();

    await userEvent.click(within(reviewCard).getByRole('button', { name: /测试连接/ }));
    await waitFor(() => expect(apiMock.modelTargetsTest).toHaveBeenCalledWith('judge-1'));

    await userEvent.clear(within(reviewCard).getByLabelText('模型名称'));
    await userEvent.type(within(reviewCard).getByLabelText('模型名称'), 'judge-model-2');
    await userEvent.click(within(reviewCard).getByRole('button', { name: '保存判定模型配置' }));

    await waitFor(() => expect(apiMock.modelTargetsUpdate).toHaveBeenCalledTimes(1));
    expect(apiMock.modelTargetsUpdate).toHaveBeenCalledWith(
      'judge-1',
      expect.objectContaining({
        name: 'AI复核',
        targetType: 'JUDGE',
        provider: 'openai-compatible',
        baseUrl: 'https://judge.example.com/v1',
        model: 'judge-model-2',
        isActive: true,
        isGlobal: true,
      }),
    );
  });

  it('在授权抽屉中展示机器指纹，避免撑开页面', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: '配置授权许可' }));
    const drawer = screen.getByRole('dialog', { name: '配置授权许可' });
    const fingerprint = within(drawer).getByText(/0ea45dc8f8f580e0d8d41d7d69d/);

    expect(fingerprint).toHaveClass('min-w-0');
    expect(fingerprint.parentElement).toHaveClass('min-w-0');
    expect(within(drawer).queryByText(/license\.json/i)).not.toBeInTheDocument();
  });

  it('在授权抽屉中导出主机信息为 JSON 文件', async () => {
    const createObjectURL = vi.fn(() => 'blob:host-info');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });

    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: '配置授权许可' }));
    const drawer = screen.getByRole('dialog', { name: '配置授权许可' });

    await userEvent.click(within(drawer).getByRole('button', { name: '导出主机信息' }));

    await waitFor(() => expect(apiMock.hostInfo).toHaveBeenCalledTimes(1));
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
  it('公钥状态以公钥环为准：单公钥未配置但公钥环已配置时显示「已配置」', async () => {
    apiMock.get.mockResolvedValue({
      configured: true,
      enforce: true,
      publicKeyConfigured: false,
      publicKeyRingConfigured: true,
      license: {
        subject: '某客户',
        status: 'ACTIVE',
        valid: true,
        reason: null,
        issuedAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2027-10-01T00:00:00.000Z',
        machineFingerprint: null,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    });
    renderPage();

    const overview = await screen.findByRole('region', { name: '配置概览' });
    const keyRow = within(overview).getByText('公钥状态').parentElement!;
    expect(within(keyRow).getByText('已配置')).toBeInTheDocument();
    expect(within(keyRow).queryByText('未配置')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '配置授权许可' }));
    const drawer = screen.getByRole('dialog', { name: '配置授权许可' });
    const drawerKeyRow = within(drawer).getByText('公钥状态').parentElement!;
    expect(within(drawerKeyRow).getByText('已配置')).toBeInTheDocument();
  });

  it('只有单公钥配置（没有公钥环字段的旧接口）时也显示「已配置」', async () => {
    apiMock.get.mockResolvedValue({
      configured: true,
      enforce: false,
      publicKeyConfigured: true,
      license: null,
    });
    renderPage();

    const overview = await screen.findByRole('region', { name: '配置概览' });
    const keyRow = within(overview).getByText('公钥状态').parentElement!;
    expect(within(keyRow).getByText('已配置')).toBeInTheDocument();
  });

  it('单公钥和公钥环都没有时才显示「未配置」', async () => {
    apiMock.get.mockResolvedValue({
      configured: false,
      enforce: false,
      publicKeyConfigured: false,
      publicKeyRingConfigured: false,
      license: null,
    });
    renderPage();

    const overview = await screen.findByRole('region', { name: '配置概览' });
    const keyRow = within(overview).getByText('公钥状态').parentElement!;
    expect(within(keyRow).getByText('未配置')).toBeInTheDocument();
  });

  it('提示条不再让人「到平台设置页面维护」（本页就在平台设置里）', async () => {
    renderPage();

    await screen.findByRole('region', { name: '配置概览' });
    expect(screen.getByText(/首次使用请上传由授权中心签发的授权文件/)).toBeInTheDocument();
    expect(screen.queryByText(/到「平台设置」页面维护/)).not.toBeInTheDocument();
    expect(screen.queryByText(/请到「平台设置」/)).not.toBeInTheDocument();
  });

  it('在平台设置里只有一个「授权许可」标题和一个「刷新」，刷新同时更新授权状态', async () => {
    renderPage('settings');

    await screen.findByRole('heading', { name: '平台设置' });
    await userEvent.click(screen.getByRole('tab', { name: /授权许可/ }));
    await screen.findByRole('button', { name: '配置授权许可' });

    expect(screen.getAllByRole('heading', { name: '授权许可' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '刷新' })).toHaveLength(1);

    const before = apiMock.get.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(apiMock.get.mock.calls.length).toBeGreaterThan(before));
  });
});
