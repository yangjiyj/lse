import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { RedTeamPolicyPage } from './RedTeamPolicyPage';

const apiMock = vi.hoisted(() => ({
  systemSettingsGet: vi.fn(),
  systemSettingsUpdate: vi.fn(),
  modelTargetsList: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    systemSettings: {
      get: apiMock.systemSettingsGet,
      update: apiMock.systemSettingsUpdate,
    },
    modelTargets: {
      list: apiMock.modelTargetsList,
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

const scrollIntoViewMock = vi.fn();

function CurrentHash() {
  return <output data-testid="location-hash">{useLocation().hash}</output>;
}

function renderPage(initialEntries = ['/redteam-policy']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <RedTeamPolicyPage />
          <CurrentHash />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('RedTeamPolicyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    apiMock.systemSettingsGet.mockResolvedValue({
      access: {},
      audit: {},
      gateway: {},
      redteam: {
        gatewayTargetId: 'gateway-target',
        attackerTargetId: 'attacker-primary',
        secondaryAttackerTargetId: '',
        judgeTargetId: '',
        breakOn: 'verdict',
        maxRounds: 6,
        noProgressK: 3,
        moves: ['probe', 'reframe'],
      },
      agent_eval: {
        attackerTargetId: '',
        judgeTargetId: '',
        adaptiveRounds: 2,
        noProgressK: 3,
        enabled: false,
      },
      updatedAt: { access: null, audit: null, gateway: null, redteam: null, agent_eval: null },
    });
    apiMock.modelTargetsList.mockResolvedValue({
      items: [
        {
          id: 'attacker-primary',
          name: '红队攻击脑 DeepSeek',
          targetType: 'MODEL',
          provider: 'newapi',
          baseUrl: 'https://api.example.test/v1',
          model: 'deepseek-r1',
          apiKeyMasked: 'sk-****',
          hasApiKey: true,
          extraHeaders: null,
          defaultParams: null,
          accessConfig: null,
          isGlobal: false,
          isActive: true,
          lastTestedAt: null,
          lastTestStatus: 'SUCCESS',
          createdAt: '2026-06-18T00:00:00.000Z',
          updatedAt: '2026-06-18T00:00:00.000Z',
          createdBy: null,
        },
        {
          id: 'judge-target',
          name: '实质裁判 GPT-4.1',
          targetType: 'JUDGE',
          provider: 'openai',
          baseUrl: 'https://api.example.test/v1',
          model: 'gpt-4.1',
          apiKeyMasked: 'sk-****',
          hasApiKey: true,
          extraHeaders: null,
          defaultParams: null,
          accessConfig: null,
          isGlobal: true,
          isActive: true,
          lastTestedAt: null,
          lastTestStatus: 'SUCCESS',
          createdAt: '2026-06-18T00:00:00.000Z',
          updatedAt: '2026-06-18T00:00:00.000Z',
          createdBy: null,
        },
        {
          id: 'gateway-target',
          name: '安全网关 Gemini',
          targetType: 'MODEL',
          provider: 'gateway',
          baseUrl: 'https://gateway.example.test/v1',
          model: 'gemini-2.5-pro',
          apiKeyMasked: 'sk-****',
          hasApiKey: true,
          extraHeaders: null,
          defaultParams: null,
          accessConfig: null,
          isGlobal: false,
          isActive: true,
          lastTestedAt: null,
          lastTestStatus: 'SUCCESS',
          createdAt: '2026-06-18T00:00:00.000Z',
          updatedAt: '2026-06-18T00:00:00.000Z',
          createdBy: null,
        },
      ],
      total: 3,
      page: 1,
      pageSize: 200,
    });
    apiMock.systemSettingsUpdate.mockImplementation(async (body) => ({
      ...(await apiMock.systemSettingsGet()),
      ...body,
    }));
  });

  it('用响应式分类导航承载三个常驻配置面板', async () => {
    renderPage();
    await screen.findByLabelText('主攻击模型');

    const tablist = screen.getByRole('tablist', { name: '对抗评估配置分类' });
    expect(tablist).toHaveClass('overflow-x-auto', 'lg:flex-col');
    expect(tablist.parentElement).toHaveClass(
      'overflow-hidden',
      'bg-white',
      'lg:grid-cols-[14rem_minmax(0,1fr)]',
    );

    for (const title of ['模型与判定', '停止与策略', '智能体自适应']) {
      expect(screen.getByRole('tab', { name: new RegExp(title) })).toBeInTheDocument();
    }

    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: /模型与判定/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(document.getElementById('redteam-panel-models')).not.toHaveAttribute('hidden');
    expect(document.getElementById('redteam-panel-strategy')).toHaveAttribute('hidden');
    expect(document.getElementById('redteam-panel-agent-adaptive')).toHaveAttribute('hidden');
  });

  it('切换分类后保留其他面板的未保存内容', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('主攻击模型');

    await user.click(screen.getByRole('tab', { name: /停止与策略/ }));
    const moves = screen.getByLabelText('策略动作');
    await user.clear(moves);
    await user.type(moves, '未保存的自定义技术');

    await user.click(screen.getByRole('tab', { name: /智能体自适应/ }));
    expect(document.getElementById('redteam-panel-strategy')).toHaveAttribute('hidden');
    expect(document.getElementById('redteam-panel-agent-adaptive')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('location-hash')).toHaveTextContent('#agent-adaptive');

    await user.click(screen.getByRole('tab', { name: /停止与策略/ }));
    expect(screen.getByLabelText('策略动作')).toHaveValue('未保存的自定义技术');
    expect(screen.getByTestId('location-hash')).toHaveTextContent('#redteam-strategy');
  });

  it.each([
    ['#redteam-models', '模型与判定', 'redteam-panel-models'],
    ['#redteam-strategy', '停止与策略', 'redteam-panel-strategy'],
    ['#agent-adaptive', '智能体自适应', 'redteam-panel-agent-adaptive'],
  ])('刷新或直达 %s 时打开对应分类', async (hash, tabName, panelId) => {
    renderPage([`/redteam-policy${hash}`]);
    await screen.findByLabelText('主攻击模型');

    expect(screen.getByRole('tab', { name: new RegExp(tabName) })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(document.getElementById(panelId)).not.toHaveAttribute('hidden');
  });

  it('嵌入设置页时切换子标签不改动 URL hash，避免把外层设置分区带跳', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/settings#redteam-policy']}>
        <QueryClientProvider client={qc}>
          <ToastProvider>
            <RedTeamPolicyPage embedded />
            <CurrentHash />
          </ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await screen.findByRole('tab', { name: /模型与判定/ });
    await user.click(screen.getByRole('tab', { name: /停止与策略/ }));

    // 内部面板正确切到「停止与策略」
    expect(screen.getByRole('tab', { name: /停止与策略/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // 关键：URL hash 保持外层设置分区不变，没有被改成 #redteam-strategy
    expect(screen.getByTestId('location-hash')).toHaveTextContent('#redteam-policy');

    await user.click(screen.getByRole('tab', { name: /智能体自适应/ }));
    expect(screen.getByRole('tab', { name: /智能体自适应/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('location-hash')).toHaveTextContent('#redteam-policy');
  });

  it('非法 hash 回到模型与判定', async () => {
    renderPage(['/redteam-policy#unknown']);
    await screen.findByLabelText('主攻击模型');

    expect(screen.getByRole('tab', { name: /模型与判定/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(document.getElementById('redteam-panel-models')).not.toHaveAttribute('hidden');
  });

  it('支持方向键、Home 和 End 循环切换焦点与面板', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('主攻击模型');

    const modelsTab = screen.getByRole('tab', { name: /模型与判定/ });
    const strategyTab = screen.getByRole('tab', { name: /停止与策略/ });
    const adaptiveTab = screen.getByRole('tab', { name: /智能体自适应/ });
    modelsTab.focus();

    await user.keyboard('{ArrowRight}');
    expect(strategyTab).toHaveFocus();
    expect(strategyTab).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    expect(adaptiveTab).toHaveFocus();

    await user.keyboard('{ArrowLeft}');
    expect(strategyTab).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(modelsTab).toHaveFocus();

    await user.keyboard('{End}');
    expect(adaptiveTab).toHaveFocus();
    expect(document.getElementById('redteam-panel-agent-adaptive')).not.toHaveAttribute('hidden');

    await user.keyboard('{Home}');
    expect(modelsTab).toHaveFocus();
    expect(document.getElementById('redteam-panel-models')).not.toHaveAttribute('hidden');
  });

  it('激活手机端最后一个分类时将标签滚入可视区域', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('主攻击模型');
    scrollIntoViewMock.mockClear();

    await user.click(screen.getByRole('tab', { name: /智能体自适应/ }));

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });
  });

  it('渲染停机条件两张卡片并可切换保存', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: '对抗评估配置' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /停止与策略/ }));
    expect(await screen.findByText('内容证据判定（推荐）')).toBeInTheDocument();
    const attitudeCard = await screen.findByText('行为倾向判定（备用）');

    await userEvent.click(attitudeCard);
    await userEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => {
      expect(apiMock.systemSettingsUpdate).toHaveBeenCalledWith({
        redteam: expect.objectContaining({ breakOn: 'attitude' }),
        agent_eval: expect.any(Object),
      });
    });
  });

  it('用客户可读的下拉选择目标，保存时提交对应 target id', async () => {
    renderPage();

    expect(await screen.findByText('红队攻击脑 DeepSeek')).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('判定模型')).getByRole('option', {
        name: /实质裁判 GPT-4\.1.*独立模型.*测试通过/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('B 侧网关 target')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('attacker-primary')).not.toBeInTheDocument();

    const judgeSelect = screen.getByLabelText('判定模型');
    await userEvent.selectOptions(
      judgeSelect,
      within(judgeSelect).getByRole('option', { name: /实质裁判 GPT-4\.1/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => {
      expect(apiMock.systemSettingsUpdate).toHaveBeenCalledWith({
        redteam: expect.objectContaining({
          attackerTargetId: 'attacker-primary',
          judgeTargetId: 'judge-target',
          gatewayTargetId: 'gateway-target',
        }),
        agent_eval: expect.any(Object),
      });
    });
    expect(apiMock.modelTargetsList).toHaveBeenCalledWith({
      page: 1,
      pageSize: 200,
      includeSystem: true,
    });
  });

  it('全局保存仍在一次请求中提交完整 redteam 与 agent_eval 配置', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('主攻击模型');

    await user.selectOptions(screen.getByLabelText('判定模型'), 'judge-target');
    await user.click(screen.getByRole('tab', { name: /停止与策略/ }));
    const moves = screen.getByLabelText('策略动作');
    await user.clear(moves);
    await user.type(moves, '身份冒充诱导{enter}自定义重构');
    await user.click(screen.getByRole('tab', { name: /智能体自适应/ }));
    await user.click(screen.getByRole('switch', { name: '默认启用智能体自适应对抗' }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(apiMock.systemSettingsUpdate).toHaveBeenCalledTimes(1);
      expect(apiMock.systemSettingsUpdate).toHaveBeenCalledWith({
        redteam: {
          gatewayTargetId: 'gateway-target',
          attackerTargetId: 'attacker-primary',
          secondaryAttackerTargetId: '',
          judgeTargetId: 'judge-target',
          breakOn: 'verdict',
          maxRounds: 6,
          noProgressK: 3,
          moves: ['身份冒充诱导', '自定义重构'],
        },
        agent_eval: {
          attackerTargetId: '',
          judgeTargetId: '',
          adaptiveRounds: 2,
          noProgressK: 3,
          enabled: true,
          fanoutEnabled: false,
        },
      });
    });
  });

  it('只有一个评估对象时可明确选择独立模型作为外部攻击脑', async () => {
    const current = await apiMock.systemSettingsGet();
    apiMock.systemSettingsGet.mockResolvedValue({
      ...current,
      redteam: { ...current.redteam, attackerTargetId: '' },
    });
    const listed = await apiMock.modelTargetsList();
    apiMock.modelTargetsList.mockResolvedValue({
      ...listed,
      items: listed.items.filter((target: { id: string }) =>
        ['attacker-primary', 'judge-target'].includes(target.id),
      ),
      total: 2,
    });

    renderPage();

    const select = await screen.findByLabelText('主攻击模型');
    expect(select).toHaveValue('');
    expect(within(select).getByRole('option', { name: /请选择外部攻击模型/ })).toBeInTheDocument();
    await userEvent.selectOptions(select, 'judge-target');
    await userEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => {
      expect(apiMock.systemSettingsUpdate).toHaveBeenCalledWith({
        redteam: expect.objectContaining({ attackerTargetId: 'judge-target' }),
        agent_eval: expect.any(Object),
      });
    });
  });

  it('攻击候选只保留配置完整的 MODEL 和 JUDGE，并优先独立模型', async () => {
    const listed = await apiMock.modelTargetsList();
    const base = listed.items[0];
    apiMock.modelTargetsList.mockResolvedValue({
      ...listed,
      items: [
        ...listed.items,
        { ...base, id: 'agent-api-target', name: 'Agent 接口', targetType: 'AGENT_API' },
        { ...base, id: 'missing-key-target', name: '缺少密钥', hasApiKey: false },
      ],
      total: 5,
    });

    renderPage();

    const select = (await screen.findByLabelText('主攻击模型')) as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.value)).toEqual([
      '',
      'judge-target',
      'attacker-primary',
      'gateway-target',
    ]);
  });
});
