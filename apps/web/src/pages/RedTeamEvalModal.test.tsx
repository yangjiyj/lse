import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { RedTeamEvalModal } from './RedTeamEvalModal';

const apiMock = vi.hoisted(() => ({
  createRedTeamTask: vi.fn(),
  listModels: vi.fn(),
  listQuestionSets: vi.fn(),
  redTeamDirections: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    evalTasks: {
      createRedTeam: apiMock.createRedTeamTask,
      redTeamDirections: apiMock.redTeamDirections,
    },
    modelTargets: { list: apiMock.listModels },
    questionSets: { list: apiMock.listQuestionSets },
  },
}));

const directionItems = [
  {
    id: 'data_security',
    riskType: 'sensitive_info_leakage',
    riskTypeLabel: '敏感信息泄露',
    label: '数据安全 / 数据泄密',
    description: '套取隐私、上下文、系统提示词、内部令牌与模型资产',
    chainSummary: '低风险上下文构建 → 分步套取 → 编码混淆 → 诱饵令牌验证',
    objectiveCount: 5,
  },
  {
    id: 'content_compliance',
    riskType: 'violating_content',
    riskTypeLabel: '违规内容生成',
    label: '内容合规',
    description: '仇恨、自伤、诈骗、虚假、未成年人、政治与极端内容',
    chainSummary: '角色扮演 → 权威施压 → 虚构场景',
    objectiveCount: 7,
  },
];

const model = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '生产 Agent 模型',
  provider: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-agent',
  apiKeyMasked: 'masked-api-key', // pragma: allowlist secret nosemgrep
  hasApiKey: true,
  extraHeaders: null,
  defaultParams: null,
  isGlobal: true,
  isActive: true,
  lastTestedAt: null,
  lastTestStatus: null,
  createdAt: '2026-06-01T08:00:00.000Z',
  updatedAt: '2026-06-01T08:00:00.000Z',
  createdBy: null,
  targetType: 'MODEL',
  accessConfig: null,
};

const judgeTarget = {
  ...model,
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  name: 'AI 复核裁判',
  provider: 'openai-compatible',
  model: 'gpt-5.5',
  targetType: 'JUDGE',
};

const redTeamSeedSet = {
  id: '12121212-1212-4121-8121-121212121212',
  name: '自主红队候选包 · 深度包',
  description: '推荐默认包，覆盖主要红队风险面',
  type: 'SHOULD_REFUSE',
  tags: ['red-team', 'red-team-seed', 'level:deep'],
  source: 'builtin:red-team:deep',
  isBuiltin: true,
  questionCount: 96,
  createdAt: '2026-06-01T08:00:00.000Z',
  updatedAt: '2026-06-01T08:00:00.000Z',
};

const legacySeedSet = {
  ...redTeamSeedSet,
  id: '13131313-1313-4131-8131-131313131313',
  name: '自主红队种子集 · 冒烟包（历史保留）',
  description: '旧版本归档保留',
  tags: ['red-team', 'red-team-seed'],
  source: 'legacy:builtin:red-team:abc',
  questionCount: 8,
};

function renderModal(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/eval-tasks']}>
        <ToastProvider>
          <Routes>
            <Route
              path="/eval-tasks"
              element={<RedTeamEvalModal open={true} onClose={() => undefined} />}
            />
            <Route path="/eval-tasks/:id" element={<div>任务详情已打开</div>} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RedTeamEvalModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listModels.mockResolvedValue({
      items: [model, judgeTarget],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    apiMock.listQuestionSets.mockResolvedValue({
      items: [redTeamSeedSet],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    apiMock.createRedTeamTask.mockResolvedValue({
      id: '77777777-7777-4777-8777-777777777777',
      name: '生产 Agent 模型 自主红队攻击',
      description: null,
      status: 'PENDING',
      modelTarget: { id: model.id, name: model.name, provider: model.provider, model: model.model },
      engines: ['rule-judge', 'sensitive-info', 'llm-judge'],
      dimensions: ['redteam_attack', 'prompt_injection', 'refusal'],
      concurrency: 1,
      totalQuestions: 8,
      processedQuestions: 0,
      passedCount: 0,
      failedCount: 0,
      errorCount: 0,
      progress: 0,
      questionSetCount: 1,
      resultCount: 0,
      logCount: 0,
      startedAt: null,
      finishedAt: null,
      createdAt: '2026-06-07T08:00:00.000Z',
      updatedAt: '2026-06-07T08:00:00.000Z',
      questionSets: [redTeamSeedSet],
    });
    apiMock.redTeamDirections.mockResolvedValue({ items: directionItems });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('多轮对抗演练：展示多模型协作、不少于5轮与三类风险分组，最大轮数不低于 5', async () => {
    renderModal();
    // 弹窗标题与首页入口、菜单统一叫“多轮对抗演练”，不再是“AI对抗演练（多轮实战对抗）”
    expect(await screen.findByRole('heading', { name: '多轮对抗演练' })).toBeInTheDocument();
    expect(screen.queryByText(/AI对抗演练/)).toBeNull();
    // 术语统一为“评估”，不说“测评”
    expect(screen.getByText(/区别于传统种子单轮对话评估/)).toBeInTheDocument();
    expect(screen.queryByText(/测评/)).toBeNull();
    expect(screen.getByLabelText('多模型协作')).toHaveTextContent('攻击模型');
    expect(screen.getByLabelText('多模型协作')).toHaveTextContent('评估模型');
    expect(screen.getByText(/持续完成不少于5轮的对抗执行/)).toBeInTheDocument();
    expect(await screen.findByText('敏感信息泄露')).toBeInTheDocument();
    expect(screen.getByText('违规内容生成')).toBeInTheDocument();
    const rounds = screen.getByLabelText('最大轮数') as HTMLInputElement;
    expect(rounds).toHaveValue(6);
    expect(rounds.min).toBe('5');
    await screen.findByDisplayValue('8');
    await userEvent.clear(rounds);
    await userEvent.type(rounds, '2');
    await userEvent.tab();
    expect(rounds).toHaveValue(5);
  });

  it('defaults sample count to a medium value and submits the selected sampleCount', async () => {
    renderModal();

    expect(await screen.findByDisplayValue('8')).toBeInTheDocument();
    expect(
      await screen.findByRole('option', { name: /深度样本库/, hidden: true }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/默认抽 4\/96/)).not.toBeInTheDocument();
    expect(
      screen.getByText(hasText('预计发起约 48 轮对抗对话，耗时约 5 分钟。')),
    ).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('样本数量'));
    await userEvent.type(screen.getByLabelText('样本数量'), '12');
    expect(
      screen.getByText(hasText('预计发起约 72 轮对抗对话，耗时约 7 分钟。')),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));

    await waitFor(() =>
      expect(api.evalTasks.createRedTeam).toHaveBeenCalledWith({
        bareTargetId: model.id,
        attackerTargetId: judgeTarget.id,
        judgeTargetId: judgeTarget.id,
        questionSetId: redTeamSeedSet.id,
        sampleCount: 12,
        maxRounds: 6,
        noProgressK: 3,
        breakOn: 'verdict',
      }),
    );
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('评估对象及同端点同模型副本不进入攻击模型候选且独立判定模型优先', async () => {
    const duplicateModel = {
      ...model,
      id: '22222222-2222-4222-8222-222222222222',
      name: '重复评估对象',
      baseUrl: 'https://API.example.com:443/v1/?tenant=shadow#ignored',
      model: ' gpt-agent ',
    };
    const anotherModel = {
      ...model,
      id: '33333333-3333-4333-8333-333333333333',
      name: '备用评估模型',
      baseUrl: 'https://backup.example.com/v1',
      model: 'gpt-agent-backup',
    };
    apiMock.listModels.mockResolvedValue({
      items: [model, duplicateModel, anotherModel, judgeTarget],
      total: 4,
      page: 1,
      pageSize: 200,
    });

    renderModal();
    await screen.findByDisplayValue('8');
    await userEvent.click(screen.getByText('高级设置'));
    const attacker = screen.getByLabelText('攻击模型') as HTMLSelectElement;
    const options = within(attacker).getAllByRole('option') as HTMLOptionElement[];

    expect(within(attacker).queryByRole('option', { name: /生产 Agent 模型/ })).toBeNull();
    expect(within(attacker).queryByRole('option', { name: /重复评估对象/ })).toBeNull();
    expect(options.map((option) => option.value)).toEqual(['', judgeTarget.id, anotherModel.id]);
    expect(attacker).toHaveValue(judgeTarget.id);
  });

  it('切换评估对象后自动把冲突攻击模型改为独立判定模型', async () => {
    const anotherModel = {
      ...model,
      id: '33333333-3333-4333-8333-333333333333',
      name: '备用评估模型',
      baseUrl: 'https://backup.example.com/v1',
      model: 'gpt-agent-backup',
    };
    apiMock.listModels.mockResolvedValue({
      items: [model, anotherModel, judgeTarget],
      total: 3,
      page: 1,
      pageSize: 200,
    });

    renderModal();
    await screen.findByDisplayValue('8');
    await userEvent.click(screen.getByText('高级设置'));
    const attacker = screen.getByLabelText('攻击模型') as HTMLSelectElement;
    await userEvent.selectOptions(attacker, anotherModel.id);
    expect(attacker).toHaveValue(anotherModel.id);

    await userEvent.selectOptions(screen.getByLabelText('评估对象'), anotherModel.id);
    await waitFor(() => expect(attacker).toHaveValue(judgeTarget.id));
  });

  it('没有独立攻击模型候选时禁用提交并引导到平台设置', async () => {
    apiMock.listModels.mockResolvedValue({
      items: [model],
      total: 1,
      page: 1,
      pageSize: 200,
    });

    renderModal();
    await screen.findByDisplayValue('8');
    await waitFor(() => expect(screen.getByLabelText('评估对象')).toHaveValue(model.id));

    expect(screen.getByLabelText('攻击模型')).toHaveValue('');
    expect(screen.getByRole('button', { name: /开始评估/ })).toBeDisabled();
    expect(
      screen.getByText(/尚未配置可用的外部攻击模型，请先到平台设置配置独立判定模型/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前往平台设置' })).toBeInTheDocument();
  });

  it('两个评估对象和独立模型都指向同一模型时解释冲突，不再提示尚未配置', async () => {
    apiMock.listModels.mockResolvedValue({
      items: [
        model,
        { ...model, id: 'second-target', name: '测试2' },
        { ...judgeTarget, baseUrl: model.baseUrl, model: model.model },
      ],
      total: 3,
      page: 1,
      pageSize: 200,
    });
    renderModal();
    expect(
      await screen.findByText(/已配置的其他模型与当前评估对象使用相同的接口地址和模型标识/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/尚未配置可用的外部攻击模型/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /开始评估/ })).toBeDisabled();
    expect(apiMock.createRedTeamTask).not.toHaveBeenCalled();
  });

  it('独立模型停用时明确提示启用现有配置', async () => {
    apiMock.listModels.mockResolvedValue({
      items: [model, { ...model, id: 'duplicate-model' }, { ...judgeTarget, isActive: false }],
      total: 3,
      page: 1,
      pageSize: 200,
    });
    renderModal();
    expect(await screen.findByText(/独立判定模型已配置但未启用/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /开始评估/ })).toBeDisabled();
  });

  it('存在重复评估对象时优先提示补全已配置的不同独立模型', async () => {
    apiMock.listModels.mockResolvedValue({
      items: [model, { ...model, id: 'duplicate-model' }, { ...judgeTarget, hasApiKey: false }],
      total: 3,
      page: 1,
      pageSize: 200,
    });
    renderModal();
    expect(await screen.findByText(/独立判定模型配置不完整/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /开始评估/ })).toBeDisabled();
  });

  it('配置读取失败时提供重试，不把读取失败当成未配置', async () => {
    apiMock.listModels.mockRejectedValueOnce(new Error('network failure'));
    renderModal();
    expect(await screen.findByText('模型配置加载失败，请重试。')).toBeInTheDocument();
    expect(screen.queryByText(/尚未配置可用的外部攻击模型/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重新加载模型' }));
    await waitFor(() => expect(screen.getByLabelText('评估对象')).toHaveValue(model.id));
    expect(screen.queryByText('模型配置加载失败，请重试。')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /开始评估/ })).toBeEnabled();
  });

  it('刷新模型列表后不保留已删除的评估对象和判定模型', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderModal(qc);
    await waitFor(() => expect(screen.getByLabelText('评估对象')).toHaveValue(model.id));
    apiMock.listModels.mockResolvedValue({
      items: [
        { ...model, id: 'remaining-model', name: '剩余评估对象' },
        { ...judgeTarget, id: 'remaining-judge', name: '剩余独立模型' },
      ],
      total: 2,
      page: 1,
      pageSize: 200,
    });
    await qc.invalidateQueries({ queryKey: ['model-targets'] });
    await waitFor(() => expect(screen.getByLabelText('评估对象')).toHaveValue('remaining-model'));
    expect(screen.getByLabelText('攻击模型')).toHaveValue('remaining-judge');
    expect(screen.getByLabelText('判定模型')).toHaveValue('remaining-judge');
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() =>
      expect(apiMock.createRedTeamTask).toHaveBeenCalledWith(
        expect.objectContaining({
          bareTargetId: 'remaining-model',
          attackerTargetId: 'remaining-judge',
          judgeTargetId: 'remaining-judge',
        }),
      ),
    );
  });

  it('已下线「加了安全网关」对照字段：界面不再出现该选项', async () => {
    renderModal();
    await screen.findByDisplayValue('8');
    expect(screen.queryByLabelText(/加了安全网关/)).not.toBeInTheDocument();
  });

  it('warns and requires confirmation when estimated attack calls are high', async () => {
    renderModal();

    await screen.findByDisplayValue('8');
    await screen.findByRole('option', { name: /深度样本库/, hidden: true });
    await userEvent.clear(screen.getByLabelText('样本数量'));
    await userEvent.type(screen.getByLabelText('样本数量'), '60');

    expect(screen.getByText(hasText('预计发起约 360 轮对抗对话，耗时约 36 分钟。'))).toHaveClass(
      'text-destructive',
    );

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));

    expect(window.confirm).toHaveBeenCalledWith(
      '本次评估预计执行 360 轮对抗对话，执行时间可能超过十分钟。确认开始吗？',
    );
    expect(api.evalTasks.createRedTeam).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));

    await waitFor(() => expect(api.evalTasks.createRedTeam).toHaveBeenCalledTimes(1));
    expect(api.evalTasks.createRedTeam).toHaveBeenCalledWith(
      expect.objectContaining({ sampleCount: 60 }),
    );
  });

  it('默认提交体不带 directions（全面，不限定方向）', async () => {
    renderModal();

    await screen.findByDisplayValue('8');
    await screen.findByRole('option', { name: /深度样本库/, hidden: true });
    // 等待攻击方向 chips 异步加载渲染，确认默认没有任何方向被选中
    await screen.findByRole('button', { name: '数据安全 / 数据泄密' });

    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => expect(api.evalTasks.createRedTeam).toHaveBeenCalledTimes(1));
    const firstBody = apiMock.createRedTeamTask.mock.calls[0]?.[0];
    expect(firstBody).toBeDefined();
    expect(firstBody).not.toHaveProperty('directions');
  });

  it('历史保留包不进内置推荐组，只在展开自定义/历史后可见', async () => {
    apiMock.listQuestionSets.mockResolvedValue({
      items: [redTeamSeedSet, legacySeedSet],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    renderModal();

    // 标准包在推荐组里
    await screen.findByRole('option', { name: /深度样本库/, hidden: true });
    // 历史保留包默认不出现
    expect(
      screen.queryByRole('option', { name: /历史保留/, hidden: true }),
    ).not.toBeInTheDocument();

    // 场景库 Select 及自定义切换按钮位于「高级设置」折叠区内，需先展开
    await userEvent.click(screen.getByText('高级设置'));
    // 展开「使用自定义 / 历史场景」后才出现
    await userEvent.click(screen.getByRole('button', { name: /使用自定义/ }));
    expect(
      await screen.findByRole('option', { name: /历史保留/, hidden: true }),
    ).toBeInTheDocument();
  });

  it('已禁用的攻击样本库不出现在候选里', async () => {
    const custom = {
      ...redTeamSeedSet,
      id: '14141414-1414-4141-8141-141414141414',
      name: '客户自建攻击库甲',
      isBuiltin: false,
      source: null,
      tags: ['red-team-seed'],
      enabled: true,
    };
    apiMock.listQuestionSets.mockResolvedValue({
      items: [
        redTeamSeedSet,
        custom,
        {
          ...custom,
          id: '15151515-1515-4151-8151-151515151515',
          name: '客户自建攻击库乙',
          enabled: false,
        },
      ],
      total: 3,
      page: 1,
      pageSize: 100,
    });
    renderModal();
    await screen.findByRole('option', { name: /深度样本库/, hidden: true });
    await userEvent.click(screen.getByText('高级设置'));
    await userEvent.click(screen.getByRole('button', { name: /使用自定义/ }));
    expect(
      await screen.findByRole('option', { name: /客户自建攻击库甲/, hidden: true }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /客户自建攻击库乙/, hidden: true }),
    ).not.toBeInTheDocument();
    expect(apiMock.listQuestionSets).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it('选定攻击方向后随提交体下发 directions', async () => {
    renderModal();

    await screen.findByDisplayValue('8');
    await screen.findByRole('option', { name: /深度样本库/, hidden: true });

    // 选定「数据安全 / 数据泄密」方向后提交体应带上该方向 id
    await userEvent.click(await screen.findByRole('button', { name: '数据安全 / 数据泄密' }));
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));

    await waitFor(() => expect(api.evalTasks.createRedTeam).toHaveBeenCalledTimes(1));
    expect(api.evalTasks.createRedTeam).toHaveBeenCalledWith(
      expect.objectContaining({ directions: ['data_security'] }),
    );
  });
});

function hasText(expected: string) {
  return (_content: string, element: Element | null) =>
    element?.textContent?.replace(/\s+/g, ' ').trim() === expected;
}
