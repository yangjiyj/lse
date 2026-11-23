import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { EvalTasksPage } from './EvalTasksPage';

const apiMock = vi.hoisted(() => ({
  listTasks: vi.fn(),
  exportTasks: vi.fn(),
  evaluationConfig: vi.fn(),
  createTask: vi.fn(),
  createBatch: vi.fn(),
  createRedTeamTask: vi.fn(),
  createComprehensiveTask: vi.fn(),
  reEval: vi.fn(),
  remove: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  listModels: vi.fn(),
  listQuestionSets: vi.fn(),
  listEngines: vi.fn(),
  generate: vi.fn(),
  runAgentEval: vi.fn(),
  previewAgentEval: vi.fn(),
  packs: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  hasPermission: vi.fn((_code: string) => true),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    evalTasks: {
      list: apiMock.listTasks,
      exportList: apiMock.exportTasks,
      create: apiMock.createTask,
      createBatch: apiMock.createBatch,
      createRedTeam: apiMock.createRedTeamTask,
      createComprehensive: apiMock.createComprehensiveTask,
      reEval: apiMock.reEval,
      remove: apiMock.remove,
      pause: apiMock.pause,
      resume: apiMock.resume,
    },
    modelTargets: { list: apiMock.listModels },
    questionSets: { list: apiMock.listQuestionSets },
    engines: { list: apiMock.listEngines },
    generator: { generate: apiMock.generate },
    evaluationConfig: { get: apiMock.evaluationConfig },
    agentEvals: {
      run: apiMock.runAgentEval,
      preview: apiMock.previewAgentEval,
      packs: apiMock.packs,
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: authMock.hasPermission }),
}));

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

const agentApiTarget = {
  ...model,
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: '客户 Agent API',
  provider: 'custom-agent',
  baseUrl: 'https://agent.example.com/chat',
  model: 'agent-api',
  targetType: 'AGENT_API',
};

const redTeamGatewayTarget = {
  ...model,
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  name: 'qwen2.5 安全网关',
  provider: 'newapi-gateway',
  baseUrl: 'http://gateway-core:8080/v1',
  model: 'qwen2.5-7b-instruct-local',
  targetType: 'MODEL',
};

const judgeTarget = {
  ...model,
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  name: 'AI 复核裁判',
  provider: 'openai-compatible',
  model: 'gpt-5.5',
  targetType: 'JUDGE',
};

const redTeamSmokeSeedSet = {
  id: '99999999-9999-4999-8999-999999999999',
  name: '自主红队候选包 · 冒烟包',
  description: '快速验证自主红队链路是否可用',
  type: 'SHOULD_REFUSE',
  tags: ['red-team', 'red-team-seed', 'level:smoke'],
  source: 'builtin:red-team',
  isBuiltin: true,
  questionCount: 4,
  createdAt: '2026-06-01T08:00:00.000Z',
  updatedAt: '2026-06-01T08:00:00.000Z',
};

const redTeamStandardSeedSet = {
  ...redTeamSmokeSeedSet,
  id: '12121212-1212-4121-8121-121212121212',
  name: '自主红队候选包 · 标准包',
  description: '推荐默认包，覆盖主要红队风险面',
  tags: ['red-team', 'red-team-seed', 'level:standard'],
  source: 'builtin:red-team:standard',
  questionCount: 96,
};

const redTeamDeepSeedSet = {
  ...redTeamSmokeSeedSet,
  id: '13131313-1313-4131-8131-131313131313',
  name: '自主红队候选包 · 深度包',
  description: '正式交付和回归使用，覆盖更多变体',
  tags: ['red-team', 'red-team-seed', 'level:deep'],
  source: 'builtin:red-team:deep',
  questionCount: 96,
};

const redTeamDemoSeedSet = {
  ...redTeamSmokeSeedSet,
  id: '14141414-1414-4141-8141-141414141414',
  name: '应拒答红队题集（演示）',
  description: '上线前安全评估演示题集',
  tags: ['red-team'],
  source: '上传:sr_demo.csv',
  isBuiltin: false,
  questionCount: 6,
};

const generatedContentSafetySet = {
  ...redTeamSmokeSeedSet,
  id: '15151515-1515-4151-8151-151515151515',
  name: 'qwen2.5 via Agent Security Gateway 内容安全测评 2026/6/16 21:40:04 样本',
  description: '自动生成内容安全样本：强度 深度对抗，重点方向 数据安全、内容合规、提示注入。',
  tags: ['gen:algo', 'variant:crescendo_seed', 'risk:prompt_injection'],
  source: 'generator:genty9d01',
  isBuiltin: false,
  questionCount: 200,
};

const largeBuiltinSet = {
  ...redTeamSmokeSeedSet,
  id: '16161616-1616-4161-8161-161616161616',
  name: '内置题库 · 中文通用安全场景（Safety-Prompts）',
  description: '',
  tags: ['内置', '内置数据集'],
  source: 'builtin:dataset:safety-prompts',
  isBuiltin: true,
  questionCount: 99798,
};

const redTeamSeedSet = redTeamStandardSeedSet;

const generatedRedTeamTaskSet = {
  ...redTeamSmokeSeedSet,
  id: '88888888-8888-4888-8888-888888888888',
  name: '本地 Qwen2.5-7B 自主红队攻击 2026/6/18 14:26:23 样本',
  description: '由「自主红队候选包」生成的自主红队任务专用样本。',
  source: 'red-team',
  isBuiltin: false,
};

const gatewayTarget = {
  ...model,
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  name: 'OpenClaw 安全网关日志源',
  provider: 'newapi-agent-security-gateway',
  baseUrl: 'https://agent-gw.example.com/admin/v1',
  model: 'gateway-log-source',
  targetType: 'GATEWAY_LOG',
  accessConfig: {
    controlPlaneBaseUrl: 'https://agent-gw.example.com/admin/v1',
    tenantId: 'tenant-a',
  },
};

const componentTarget = {
  ...model,
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'MCP 工具描述',
  provider: 'mcp-openapi',
  baseUrl: 'https://agent.example.com/openapi.json',
  model: 'mcp-openapi',
  targetType: 'MCP_OPENAPI',
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/eval-tasks']}>
        <ToastProvider>
          <Routes>
            <Route path="/eval-tasks" element={<EvalTasksPage />} />
            <Route path="/eval-tasks/compare" element={<div>对比页已打开</div>} />
            <Route path="/eval-tasks/:id" element={<div>任务详情已打开</div>} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EvalTasksPage agent quick eval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.evaluationConfig.mockResolvedValue({ questionCount: 80 });
    authMock.hasPermission.mockImplementation(() => true);
    apiMock.listTasks.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    apiMock.listModels.mockResolvedValue({
      items: [
        model,
        redTeamGatewayTarget,
        judgeTarget,
        agentApiTarget,
        gatewayTarget,
        componentTarget,
      ],
      total: 6,
      page: 1,
      pageSize: 100,
    });
    apiMock.listQuestionSets.mockResolvedValue({
      items: [
        generatedRedTeamTaskSet,
        generatedContentSafetySet,
        largeBuiltinSet,
        redTeamDemoSeedSet,
        redTeamDeepSeedSet,
        redTeamSmokeSeedSet,
        redTeamStandardSeedSet,
      ],
      total: 7,
      page: 1,
      pageSize: 100,
    });
    apiMock.listEngines.mockResolvedValue([
      {
        engine: 'rule-judge',
        kind: 'per-question',
        builtin: true,
        available: true,
        label: '规则引擎',
        description: '',
      },
      {
        engine: 'sensitive-info',
        kind: 'per-question',
        builtin: true,
        available: true,
        label: '敏感信息检测',
        description: '',
      },
      {
        engine: 'python-judge',
        kind: 'per-question',
        builtin: false,
        available: true,
        label: 'Python 判定 Sidecar',
        description: '',
      },
      {
        engine: 'ai-infra-guard',
        kind: 'task-level',
        builtin: false,
        available: false,
        label: 'AI-Infra-Guard 红队扫描',
        description: '',
      },
    ]);
    apiMock.generate.mockResolvedValue({
      questionSetId: '44444444-4444-4444-8444-444444444444',
      requested: 80,
      produced: 80,
      capacityCeiling: 500,
      seed: 'content-seed',
    });
    apiMock.createTask.mockResolvedValue({
      id: '55555555-5555-4555-8555-555555555555',
      name: '生产 Agent 模型 内容安全测评',
      description: null,
      status: 'PENDING',
      modelTarget: { id: model.id, name: model.name, provider: model.provider, model: model.model },
      engines: ['rule-judge', 'sensitive-info'],
      dimensions: [
        'compliance',
        'refusal',
        'prompt_injection',
        'sensitive_info',
        'privacy_leakage',
        'cyber_abuse',
        'fraud_social_engineering',
        'system_prompt_leakage',
        'training_data_extraction',
        'rag_data_poisoning',
        'agent_tool_abuse',
        'data_exfiltration',
        'ssrf_network_access',
        'output_injection',
        'misinformation_hallucination',
        'unsafe_professional_advice',
        'bias_discrimination',
        'model_denial_of_service',
        'model_theft',
        'robustness',
      ],
      concurrency: 4,
      totalQuestions: 80,
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
      questionSets: [],
    });
    apiMock.createComprehensiveTask.mockResolvedValue({
      id: '66666666-6666-4666-8666-666666666666',
      name: '生产 Agent 模型 综合安全评估',
      description: '综合安全评估',
      status: 'PENDING',
      modelTarget: { id: model.id, name: model.name, provider: model.provider, model: model.model },
      engines: ['rule-judge', 'sensitive-info', 'llm-judge', 'agent-tool-guard'],
      dimensions: ['comprehensive', 'content_safety', 'redteam_attack', 'agent_tool_call'],
      concurrency: 4,
      totalQuestions: 64,
      processedQuestions: 0,
      passedCount: 0,
      failedCount: 0,
      errorCount: 0,
      progress: 0,
      questionSetCount: 4,
      resultCount: 0,
      logCount: 0,
      startedAt: null,
      finishedAt: null,
      createdAt: '2026-08-21T08:00:00.000Z',
      updatedAt: '2026-08-21T08:00:00.000Z',
      questionSets: [],
    });
    apiMock.previewAgentEval.mockResolvedValue({
      samples: [],
      strength: {
        level: 'standard',
        label: '标准评估',
        defaultSampleCount: 48,
        minSampleCount: 8,
        maxSampleCount: 160,
        maxTurns: 2,
        variantDepth: 2,
        riskSurfaces: ['ssrf', 'secret_read', 'data_exfiltration'],
      },
      sampleCount: 48,
      seed: 'preview-seed',
      riskSurfaces: ['ssrf', 'secret_read', 'data_exfiltration'],
      packIds: ['builtin-agent-attacks'],
      maxConcurrency: 4,
      timeoutMs: null,
    });
    apiMock.packs.mockResolvedValue({
      items: [
        {
          id: 'builtin-agent-attacks',
          version: '2026.06.01',
          templateCount: 12,
          riskSurfaces: ['ssrf', 'secret_read', 'data_exfiltration'],
          sourceRefs: ['builtin'],
          templates: [],
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    apiMock.runAgentEval.mockResolvedValue({
      taskId: '22222222-2222-4222-8222-222222222222',
      questionSetId: '33333333-3333-4333-8333-333333333333',
      level: 'standard',
      sampleCount: 48,
      seed: 'run-seed',
      riskSurfaces: ['ssrf', 'secret_read', 'data_exfiltration'],
      saveQuestionSet: false,
      attackPackVersion: '2026.06.01',
      packIds: ['builtin-agent-attacks'],
      maxConcurrency: 4,
      timeoutMs: null,
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
      totalQuestions: 4,
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
  });

  async function choosePlan(name: RegExp, line: '内容' | '智能体' = '内容', expert = false) {
    await userEvent.click(screen.getByRole('button', { name: '新建评估' }));
    await within(screen.getByLabelText('本次评估对象')).findByRole('option', {
      name: /生产 Agent 模型/,
    });
    await userEvent.selectOptions(screen.getByLabelText('本次评估对象'), model.id);
    if (line === '智能体') await userEvent.click(screen.getByRole('button', { name: /智能体应用安全/ }));
    if (expert) await userEvent.click(screen.getByLabelText('显示专家方案'));
    await userEvent.click(screen.getByRole('button', { name }));
  }

  it('任务列表优先，以新建评估进入方案选择并保留专项能力', async () => {
    renderPage();

    expect(screen.queryByText('评估工作流')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建评估' })).toBeInTheDocument();
    expect(await screen.findByText('暂无评估任务')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '新建评估' }));
    expect(await screen.findByRole('heading', { name: '选择评估方案' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /综合评估/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /题库抽测/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /题库抽测/ })).toBeInTheDocument();
    // 第一层三条测评线，默认落在内容线；智能体线、终端线点一下切换。
    for (const name of [/大模型内容安全/, /智能体应用安全/, /终端智能体安全/])
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    for (const name of [/标准评估/, /多轮红队/, /多模态越狱/])
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /智能体应用安全/ }));
    for (const name of [/沙箱评估/, /平台应用评估/, /MCP 专项/])
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /导入外部轨迹/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('显示专家方案'));
    expect(screen.getByRole('button', { name: /导入外部轨迹/ })).toBeInTheDocument();
    expect(screen.queryByText('组件暴露面扫描')).not.toBeInTheDocument();
  });

  it('应用 API 只能用兼容方案，其余方案置灰，并把所选对象带入表单', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: '新建评估' }));
    await within(screen.getByLabelText('本次评估对象')).findByRole('option', {
      name: /客户 Agent API/,
    });
    await userEvent.selectOptions(screen.getByLabelText('本次评估对象'), agentApiTarget.id);
    await userEvent.click(screen.getByLabelText('显示专家方案'));
    for (const name of [/综合评估/, /标准评估/, /多轮红队/, /间接提示注入/]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    await userEvent.click(screen.getByRole('button', { name: /智能体应用安全/ }));
    expect(screen.getByRole('button', { name: /沙箱评估/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /大模型内容安全/ }));
    await userEvent.click(screen.getByRole('button', { name: /题库抽测/ }));
    expect(await screen.findByLabelText('评估对象')).toHaveValue(agentApiTarget.id);
  });

  it('综合入口默认选择四个核心模块，并以一个任务提交随机混排配置', async () => {
    renderPage();
    await choosePlan(/综合评估/, '内容', true);

    expect(await screen.findByRole('heading', { name: '发起综合安全评估' })).toBeInTheDocument();
    expect(screen.getByText(/一次创建一个任务，随机混排执行多类测试/)).toBeInTheDocument();
    expect(screen.getByLabelText('内容安全评估')).toBeChecked();
    expect(screen.getByLabelText('自主红队评估')).toBeChecked();
    expect(screen.getByLabelText('智能体工具安全评估')).toBeChecked();
    expect(screen.getByLabelText('间接提示注入评估')).toBeChecked();
    expect(screen.getByLabelText('运行轨迹导入分析')).not.toBeChecked();
    expect(screen.getByLabelText('样本库回归评估')).not.toBeChecked();
    expect(screen.getByLabelText('评估对象')).toHaveValue(model.id);
    expect(screen.queryByText('请先在表单顶部选择评估对象')).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('评估对象'), model.id);
    await userEvent.click(screen.getByRole('radio', { name: /随机抽样验证/ }));
    expect(screen.getByLabelText('内容安全样本数')).toHaveValue(36);
    expect(screen.getByLabelText('自主红队场景数')).toHaveValue(4);
    expect(screen.getByLabelText('智能体工具安全样本数')).toHaveValue(12);
    expect(screen.getByLabelText('间接提示注入样本数')).toHaveValue(12);
    await userEvent.clear(screen.getByLabelText('内容安全样本数'));
    await userEvent.type(screen.getByLabelText('内容安全样本数'), '50');
    await userEvent.type(screen.getByLabelText('复测 seed'), 'daily-fixed-seed');
    await userEvent.click(screen.getByRole('button', { name: '创建并执行' }));

    await waitFor(() => expect(apiMock.createComprehensiveTask).toHaveBeenCalledTimes(1));
    expect(apiMock.createComprehensiveTask).toHaveBeenCalledWith({
      modelTargetId: model.id,
      mode: 'random',
      modules: [
        'content_safety',
        'autonomous_red_team',
        'agent_tool_safety',
        'indirect_prompt_injection',
      ],
      sampleCounts: {
        content_safety: 50,
        autonomous_red_team: 4,
        agent_tool_safety: 12,
        indirect_prompt_injection: 12,
      },
      concurrency: 4,
      seed: 'daily-fixed-seed',
    });
    expect(await screen.findByText('任务详情已打开')).toBeInTheDocument();
  });

  it('长任务名截断并保留完整名称的悬浮提示', async () => {
    const longName =
      '网关 Assurance Agent 攻防复测 auto-20260618-093012-第七轮-间接注入与越权外发组合场景';
    apiMock.listTasks.mockResolvedValue({
      items: [
        {
          id: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
          name: longName,
          description: null,
          status: 'COMPLETED',
          modelTarget: {
            id: model.id,
            name: model.name,
            provider: model.provider,
            model: model.model,
          },
          engines: ['content-safety'],
          dimensions: ['content_safety'],
          concurrency: 1,
          totalQuestions: 50,
          processedQuestions: 24,
          passedCount: 20,
          failedCount: 4,
          errorCount: 0,
          progress: 0.48,
          questionSetCount: 1,
          resultCount: 24,
          logCount: 0,
          startedAt: null,
          finishedAt: null,
          createdAt: '2026-06-07T08:00:00.000Z',
          updatedAt: '2026-06-07T08:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    renderPage();

    const nameEl = await screen.findByText(longName);
    // 最多两行省略而非撑高行：保证列表行高一致
    expect(nameEl).toHaveClass('line-clamp-2');
    expect(nameEl).toHaveClass('min-w-0');
    // 完整名称仍可通过悬浮提示读到，避免区分度落在被裁掉的尾部
    expect(nameEl).toHaveAttribute('title', longName);
  });

  it('结果列不再展示网关对照的隐身/拦截 pill', async () => {
    apiMock.listTasks.mockResolvedValue({
      items: [
        {
          id: 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0',
          name: '自主红队隐身破防任务',
          description: null,
          status: 'COMPLETED',
          modelTarget: {
            id: model.id,
            name: 'qwen2.5 via Agent Security Gateway',
            provider: model.provider,
            model: model.model,
          },
          engines: ['autonomous-red-team'],
          dimensions: ['redteam_attack'],
          concurrency: 1,
          totalQuestions: 4,
          processedQuestions: 4,
          passedCount: 1,
          failedCount: 3,
          errorCount: 0,
          progress: 1,
          questionSetCount: 1,
          resultCount: 4,
          logCount: 0,
          stealthBreakCount: 2,
          recognizedCount: 1,
          startedAt: null,
          finishedAt: null,
          createdAt: '2026-06-07T08:00:00.000Z',
          updatedAt: '2026-06-07T08:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    renderPage();

    expect(await screen.findByText('自主红队隐身破防任务')).toBeInTheDocument();
    // 网关对照的隐身/拦截 pill 已随网关功能移除：确认不再渲染
    expect(screen.queryByText('隐身破防 2')).not.toBeInTheDocument();
    expect(screen.queryByText('已拦截 1')).not.toBeInTheDocument();
  });

  it('结果列在无隐身分层数据时明确说明旧任务数据缺失', async () => {
    apiMock.listTasks.mockResolvedValue({
      items: [
        {
          id: 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0',
          name: '旧引擎红队任务',
          description: null,
          status: 'COMPLETED',
          modelTarget: {
            id: model.id,
            name: '测试模型',
            provider: model.provider,
            model: model.model,
          },
          engines: ['autonomous-red-team'],
          dimensions: ['redteam_attack'],
          concurrency: 1,
          totalQuestions: 4,
          processedQuestions: 4,
          passedCount: 4,
          failedCount: 0,
          errorCount: 0,
          progress: 1,
          questionSetCount: 1,
          resultCount: 4,
          logCount: 0,
          startedAt: null,
          finishedAt: null,
          createdAt: '2026-06-07T08:00:00.000Z',
          updatedAt: '2026-06-07T08:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    renderPage();

    expect(await screen.findByText('旧引擎红队任务')).toBeInTheDocument();
    expect(screen.getByText('本次未生成攻击回合的逐层明细')).toBeInTheDocument();
    expect(screen.queryByText(/隐身破防 \d/)).not.toBeInTheDocument();
  });

  it('全异常任务显示不完整结论而不是未发现问题', async () => {
    apiMock.listTasks.mockResolvedValue({
      items: [
        {
          id: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0',
          name: '全异常任务',
          description: null,
          status: 'COMPLETED',
          modelTarget: {
            id: model.id,
            name: '测试模型',
            provider: model.provider,
            model: model.model,
          },
          engines: ['rule-judge'],
          dimensions: [],
          concurrency: 1,
          totalQuestions: 8,
          processedQuestions: 8,
          passedCount: 0,
          failedCount: 0,
          errorCount: 8,
          unknownCount: 0,
          skippedEngineCount: 0,
          progress: 1,
          questionSetCount: 1,
          resultCount: 8,
          logCount: 0,
          startedAt: null,
          finishedAt: null,
          createdAt: '2026-06-07T08:00:00.000Z',
          updatedAt: '2026-06-07T08:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    renderPage();

    const outcomeBadge = await screen.findByText('评估不完整，未形成完整结论');
    expect(outcomeBadge).toBeInTheDocument();
    expect(outcomeBadge).toHaveAttribute('tabindex', '0');
    expect(outcomeBadge).toHaveAccessibleName(/8 项执行异常/);
    expect(screen.getByText('通过 0 · 风险 0 · 异常 8 · 未判定 0')).toBeInTheDocument();
    expect(screen.queryByText('未发现问题')).not.toBeInTheDocument();
  });

  it('持续闭环任务展示最近运行和累计轮次，避免看起来只执行一次', async () => {
    apiMock.listTasks.mockResolvedValue({
      items: [
        {
          id: 'c4e1f14a-a51f-455b-a65c-81e282bb7a00',
          name: '网关 Assurance 自动闭环 2026-06-20',
          description:
            '自动闭环对大模型安全网关发起保障样本。\n最近运行：auto-20260620-132757\n样本：10 条，通过 10 条，风险 0 条。',
          status: 'COMPLETED',
          modelTarget: {
            id: model.id,
            name: 'qwen2.5 via Agent Security Gateway',
            provider: model.provider,
            model: model.model,
          },
          engines: ['gateway-assurance'],
          dimensions: ['gateway_recording'],
          concurrency: 1,
          totalQuestions: 10,
          processedQuestions: 10,
          passedCount: 10,
          failedCount: 0,
          errorCount: 0,
          progress: 100,
          questionSetCount: 1,
          resultCount: 0,
          logCount: 19,
          startedAt: '2026-06-20T05:28:03.264Z',
          finishedAt: '2026-06-20T05:28:03.264Z',
          createdAt: '2026-06-20T04:01:21.910Z',
          updatedAt: '2026-06-20T05:28:03.267Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    renderPage();

    expect(await screen.findByText('网关 Assurance 自动闭环 2026-06-20')).toBeInTheDocument();
    expect(screen.getByText('持续闭环')).toBeInTheDocument();
    expect(screen.getByText(/累计 19 轮/)).toBeInTheDocument();
    expect(screen.queryByText(/最近运行 auto-20260620-132757/)).not.toBeInTheDocument();
    expect(screen.getByText(/最近更新/)).toBeInTheDocument();
  });

  it('自主红队默认按标准内置包发起，不把历史内容安全题集混进入口', async () => {
    renderPage();

    await choosePlan(/多轮红队/);

    expect(screen.getByRole('heading', { name: '多轮对抗演练' })).toBeInTheDocument();
    expect(screen.getByLabelText('评估对象')).toBeInTheDocument();
    // 对抗样本库 / 攻击模型 / 判定模型已移入「高级设置」折叠区（jsdom 中折叠内子节点仍可查询）
    expect(screen.getByLabelText('攻击模型')).toBeInTheDocument();
    expect(screen.getByLabelText('判定模型')).toBeInTheDocument();
    const seedSelect = screen.getByLabelText('对抗样本库') as HTMLSelectElement;
    expect(seedSelect).toBeInTheDocument();
    // 只暴露深度内置包；默认选中深度场景库
    expect(seedSelect.value).toBe(redTeamDeepSeedSet.id);
    expect(screen.getByText('深度样本库 · 全面覆盖')).toBeInTheDocument();
    // 抽样默认 8
    expect(screen.getByDisplayValue('8')).toBeInTheDocument();
    // 标准/冒烟内置包不再作为下拉选项呈现
    expect(screen.queryByText(/自主红队候选包 · 冒烟包/)).not.toBeInTheDocument();
    expect(screen.queryByText(/自主红队候选包 · 标准包/)).not.toBeInTheDocument();
    expect(screen.queryByText(/本地 Qwen2\.5-7B 自主红队攻击/)).not.toBeInTheDocument();
    expect(screen.queryByText(/内容安全测评 2026\/6\/16/)).not.toBeInTheDocument();
    expect(screen.queryByText(/应拒答红队题集/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /使用自定义 \/ 历史样本库/ }));
    expect(screen.getByText(/应拒答红队题集/)).toBeInTheDocument();
    expect(screen.queryByText(/内容安全测评 2026\/6\/16/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/加了安全网关/)).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('评估对象'), model.id);
    await userEvent.selectOptions(screen.getByLabelText('攻击模型'), judgeTarget.id);
    await userEvent.selectOptions(screen.getByLabelText('判定模型'), judgeTarget.id);
    await userEvent.selectOptions(screen.getByLabelText('对抗样本库'), redTeamDeepSeedSet.id);
    await userEvent.click(screen.getByRole('button', { name: '开始评估' }));

    await waitFor(() => expect(api.evalTasks.createRedTeam).toHaveBeenCalledTimes(1));
    expect(api.evalTasks.createRedTeam).toHaveBeenCalledWith(
      expect.not.objectContaining({ gatewayTargetId: expect.any(String) }),
    );
  });

  it('自主红队入口创建单目标多轮攻击任务', async () => {
    renderPage();

    await choosePlan(/多轮红队/);

    expect(await screen.findByRole('heading', { name: '多轮对抗演练' })).toBeInTheDocument();
    expect(screen.getByLabelText('评估对象')).toBeInTheDocument();
    expect(screen.queryByLabelText('防护后对象')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /对照防护层/ })).not.toBeInTheDocument();
    // 攻击模型 / 判定模型 / 对抗样本库均在高级设置折叠区内
    expect(screen.getByLabelText('攻击模型')).toBeInTheDocument();
    expect(screen.getByLabelText('判定模型')).toBeInTheDocument();
    expect(screen.getByLabelText('对抗样本库')).toBeInTheDocument();
    expect(screen.getByText('深度样本库 · 全面覆盖')).toBeInTheDocument();
    expect(screen.queryByText(/targetId/)).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('评估对象'), model.id);
    await userEvent.selectOptions(screen.getByLabelText('攻击模型'), judgeTarget.id);
    await userEvent.selectOptions(screen.getByLabelText('判定模型'), judgeTarget.id);
    await userEvent.selectOptions(screen.getByLabelText('对抗样本库'), redTeamDeepSeedSet.id);

    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));

    await waitFor(() =>
      expect(api.evalTasks.createRedTeam).toHaveBeenCalledWith({
        bareTargetId: model.id,
        attackerTargetId: judgeTarget.id,
        judgeTargetId: judgeTarget.id,
        questionSetId: redTeamDeepSeedSet.id,
        sampleCount: 8,
        maxRounds: 6,
        noProgressK: 3,
        breakOn: 'verdict',
      }),
    );
    await waitFor(() => expect(screen.getAllByText('任务详情已打开').length).toBeGreaterThan(0));
  });

  it('样本库回归评估入口打开的 modal 明确要求选择已有样本库', async () => {
    renderPage();

    await choosePlan(/整改复测 \/ 样本回归/, '内容', true);

    expect(await screen.findByText('新建样本库回归评估')).toBeInTheDocument();
    expect(screen.getByText(/执行样本库中的测试样本/)).toBeInTheDocument();
    expect(screen.getByText(/任务详情将展示结论、执行缺口与逐项结果/)).toBeInTheDocument();
    expect(screen.getByText('样本库（必选）')).toBeInTheDocument();
    expect(screen.getByLabelText('评估对象')).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).getByRole('option', { name: /生产 Agent 模型/ }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).getByRole('option', { name: /客户 Agent API/ }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).queryByRole('option', {
        name: /OpenClaw 安全网关日志源/,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).queryByRole('option', { name: /MCP 工具描述/ }),
    ).not.toBeInTheDocument();
  });

  it('建任务时只列出启用的样本库', async () => {
    renderPage();
    await choosePlan(/整改复测 \/ 样本回归/, '内容', true);
    expect(await screen.findByText('新建样本库回归评估')).toBeInTheDocument();
    await waitFor(() =>
      expect(apiMock.listQuestionSets).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      ),
    );
  });

  it('样本库回归弹窗：去掉维度手勾、只展示可用引擎(未部署隐藏)、提交自动命名+空维度', async () => {
    renderPage();
    await choosePlan(/整改复测 \/ 样本回归/, '内容', true);
    await screen.findByText('新建样本库回归评估');

    // 不再有"评估维度"手勾区
    expect(screen.queryByText('评估维度')).not.toBeInTheDocument();

    // 只展示可用引擎；未部署的不外露（避免客户误读为产品缺失），也不再出现「未部署」字样
    // 引擎名走能力口径中文（不外露后端引擎标识/英文原名）
    expect(await screen.findByText('AI 深度语义判定')).toBeInTheDocument();
    expect(screen.queryByText('Python 判定 Sidecar')).not.toBeInTheDocument();
    expect(screen.queryByText('AI-Infra-Guard 红队扫描')).not.toBeInTheDocument();
    expect(screen.queryByText('未部署')).not.toBeInTheDocument();

    // 选评估对象 + 一个样本库即可提交（任务名称非必填）
    await userEvent.selectOptions(screen.getByLabelText('评估对象'), model.id);
    await userEvent.click(screen.getByText(/内容安全测评 2026\/6\/16/));
    await userEvent.click(screen.getByRole('button', { name: /创建并执行/ }));

    await waitFor(() => expect(apiMock.createTask).toHaveBeenCalledTimes(1));
    const body = apiMock.createTask.mock.calls[0]?.[0];
    expect(body).toBeTruthy();
    expect(body.dimensions).toEqual([]); // 维度由后端按样本库推断
    expect(typeof body.name).toBe('string');
    expect(body.name.length).toBeGreaterThan(0); // 自动命名
    expect(body.engines).toEqual(['rule-judge', 'sensitive-info']);
    expect(body.engines).not.toContain('ai-infra-guard'); // 未部署不下发
  });

  it('样本库回归：选中 10 万级内置题库提示抽样，一键按 2,000 题分层抽样并随任务提交', async () => {
    renderPage();
    await choosePlan(/整改复测 \/ 样本回归/, '内容', true);
    await screen.findByText('新建样本库回归评估');
    await userEvent.selectOptions(screen.getByLabelText('评估对象'), model.id);
    await userEvent.click(await screen.findByText('内置题库 · 中文通用安全场景（Safety-Prompts）'));
    expect(screen.getByText('（99,798 条）')).toBeInTheDocument();
    expect(
      screen.getByText(/已选样本库合计 99,798 题，本次将评估\s*99,798\s*题/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '按 2,000 题分层抽样' }));
    expect(screen.getByLabelText('抽样题数')).toHaveValue(2000);
    expect(screen.getByText(/本次将评估\s*2,000\s*题/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /创建并执行/ }));
    await waitFor(() => expect(apiMock.createTask).toHaveBeenCalledTimes(1));
    expect(apiMock.createTask.mock.calls[0]?.[0].sampleSize).toBe(2000);
  });

  it('样本库回归：抽样题数越界时禁止提交', async () => {
    renderPage();
    await choosePlan(/整改复测 \/ 样本回归/, '内容', true);
    await screen.findByText('新建样本库回归评估');
    await userEvent.selectOptions(screen.getByLabelText('评估对象'), model.id);
    await userEvent.click(await screen.findByText('内置题库 · 中文通用安全场景（Safety-Prompts）'));
    await userEvent.type(screen.getByLabelText('抽样题数'), '20001');
    expect(screen.getByText(/抽样题数须为 1–20,000 的整数/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /创建并执行/ })).toBeDisabled();
  });

  it('迟到的默认配置不能覆盖管理员已填写的样本总数', async () => {
    let finish!: (value: { questionCount: number }) => void;
    apiMock.evaluationConfig.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderPage();
    await choosePlan(/题库抽测/);
    await userEvent.clear(screen.getByLabelText('样本总数'));
    await userEvent.type(screen.getByLabelText('样本总数'), '37');
    await act(async () => finish({ questionCount: 120 }));
    await userEvent.click(screen.getByRole('button', { name: /高级配置/ }));
    await userEvent.click(screen.getByRole('button', { name: /高级配置/ }));
    await waitFor(() => expect(screen.getByLabelText('样本总数')).toHaveValue(37));
  });

  it('内容样本数量超出上限时明确说明并阻止发起', async () => {
    renderPage();
    await choosePlan(/题库抽测/);
    await userEvent.clear(screen.getByLabelText('样本总数'));
    await userEvent.type(screen.getByLabelText('样本总数'), '2001');
    expect(screen.getByRole('button', { name: /开始评估/ })).toBeDisabled();
    expect(screen.getByText('样本总数须为 1–2000 的整数。')).toBeInTheDocument();
    expect(apiMock.generate).not.toHaveBeenCalled();
  });

  it('样本库回归按题库可用数量显示上限并禁止超量', async () => {
    apiMock.listQuestionSets.mockResolvedValue({
      items: [{ ...generatedContentSafetySet, questionCount: 5 }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    renderPage();
    await choosePlan(/整改复测 \/ 样本回归/, '内容', true);
    await userEvent.click(await screen.findByText(/内容安全测评 2026\/6\/16/));
    const input = screen.getByLabelText('抽样题数');
    expect(input).toHaveAttribute('max', '5');
    await userEvent.type(input, '6');
    expect(screen.getByRole('button', { name: /创建并执行/ })).toBeDisabled();
    expect(screen.getByText('抽样题数须为 1–5 的整数')).toBeInTheDocument();
  });

  it('智能体线「MCP 专项」走样本库回归，并预选内置的 MCP 专项样本库和所选对象', async () => {
    apiMock.listQuestionSets.mockResolvedValue({
      items: [
        generatedContentSafetySet,
        {
          ...generatedContentSafetySet,
          id: 'mcp-seed-set',
          name: 'MCP 专项样本库',
          source: 'builtin:mcp:builtin-mcp-attacks@2026-10-15.2',
          isBuiltin: true,
          questionCount: 40,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    renderPage();
    await choosePlan(/MCP 专项/, '智能体');
    expect(await screen.findByText('新建样本库回归评估')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /MCP 专项样本库/ })).toBeChecked(),
    );
    expect(screen.getByRole('checkbox', { name: /内容安全测评 2026\/6\/16/ })).not.toBeChecked();
    expect(screen.getByLabelText('评估对象')).toHaveValue(model.id);
    expect(apiMock.listQuestionSets).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: 'MCP', origin: 'builtin' }),
    );
  });

  it('内容安全样本总数直接可填，收起高级配置后仍按输入数量执行', async () => {
    renderPage();
    await choosePlan(/题库抽测/);
    const count = await screen.findByLabelText('样本总数');
    expect(count).toHaveAttribute('max', '2000');
    await userEvent.clear(count);
    await userEvent.type(count, '37');
    await userEvent.click(screen.getByRole('button', { name: /高级配置/ }));
    await userEvent.click(screen.getByRole('button', { name: /高级配置/ }));
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() =>
      expect(apiMock.generate).toHaveBeenCalledWith(expect.objectContaining({ count: 37 })),
    );
  });

  it('内容安全测评自动生成样本并创建评估任务，不要求选择样本库', async () => {
    renderPage();

    await choosePlan(/题库抽测/);

    expect(await screen.findByText('发起内容安全评估')).toBeInTheDocument();
    expect(screen.getByLabelText('评估对象')).toBeInTheDocument();
    // 强度选择器（标准评估/深度对抗等）已移入高级配置，普通视图不再展示
    expect(screen.queryByRole('button', { name: /标准评估/ })).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).getByRole('option', { name: /生产 Agent 模型/ }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).getByRole('option', { name: /客户 Agent API/ }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).queryByRole('option', {
        name: /OpenClaw 安全网关日志源/,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).queryByRole('option', { name: /MCP 工具描述/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('样本库（必选）')).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('评估对象'), model.id);
    const submitButtons = screen.getAllByRole('button', { name: /开始评估/ });
    await userEvent.click(submitButtons[submitButtons.length - 1]!);

    await waitFor(() =>
      expect(api.generator.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringContaining('生产 Agent 模型 内容安全评估'),
          description: expect.stringContaining('自动生成'),
          types: ['SHOULD_REFUSE', 'COMPLIANCE', 'PROMPT_INJECTION', 'GENERAL'],
          categories: expect.arrayContaining([
            '危险物品',
            '网络滥用',
            '诈骗与社会工程',
            '数据泄露',
            '提示注入',
            'RAG 污染',
            '输出处理注入',
            '训练数据提取',
            '模型盗用',
            '资源消耗',
            '模型幻觉',
          ]),
          language: 'auto',
          count: 80,
          variantStrength: 'auto',
          dedupe: true,
        }),
      ),
    );
    await waitFor(() =>
      expect(api.evalTasks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringContaining('生产 Agent 模型 内容安全评估'),
          description: expect.stringContaining('自动生成 80 个内容安全样本'),
          modelTargetId: model.id,
          questionSetIds: ['44444444-4444-4444-8444-444444444444'],
          engines: ['rule-judge', 'sensitive-info'],
          dimensions: expect.arrayContaining([
            'compliance',
            'refusal',
            'prompt_injection',
            'sensitive_info',
            'privacy_leakage',
            'cyber_abuse',
            'fraud_social_engineering',
            'rag_data_poisoning',
            'misinformation_hallucination',
            'model_theft',
          ]),
          concurrency: 4,
        }),
      ),
    );
    expect(await screen.findByText('任务详情已打开')).toBeInTheDocument();
  });

  it('配置管理的单次评估题数作为内容安全评估默认样本数并真实生效', async () => {
    apiMock.evaluationConfig.mockResolvedValue({
      dimensionWeights: { COMPLIANCE: 40, PROMPT_INJECTION: 30, SHOULD_REFUSE: 20, GENERAL: 10 },
      questionCount: 120,
      scoreWeights: { passRate: 70, severity: 30 },
    });
    renderPage();
    await choosePlan(/题库抽测/);
    await userEvent.selectOptions(await screen.findByLabelText('评估对象'), model.id);
    await waitFor(() => expect(apiMock.evaluationConfig).toHaveBeenCalled());
    const submitButtons = screen.getAllByRole('button', { name: /开始评估/ });
    await userEvent.click(submitButtons[submitButtons.length - 1]!);
    await waitFor(() =>
      expect(api.generator.generate).toHaveBeenCalledWith(expect.objectContaining({ count: 120 })),
    );
  });

  it('内容安全高级配置可以聚焦重点方向并影响随机样本生成', async () => {
    renderPage();

    await choosePlan(/题库抽测/);
    expect(await screen.findByText('发起内容安全评估')).toBeInTheDocument();
    expect(screen.getByText(/默认使用标准强度并覆盖全部风险域/)).toBeInTheDocument();
    expect(screen.queryByText('重点方向')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /高级配置/ }));

    expect(screen.getByText('重点方向')).toBeInTheDocument();
    expect(screen.getByLabelText('数据安全')).toBeChecked();
    expect(screen.getByLabelText('内容合规')).toBeChecked();
    expect(screen.getByLabelText('提示注入')).toBeChecked();
    expect(screen.getByLabelText('网络滥用')).toBeInTheDocument();
    expect(screen.getByLabelText('诈骗与社会工程')).toBeInTheDocument();
    expect(screen.getByLabelText('RAG / 知识库')).toBeInTheDocument();
    expect(screen.getByLabelText('模型幻觉')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('内容合规'));
    await userEvent.click(screen.getByLabelText('提示注入'));
    await userEvent.click(screen.getByLabelText('网络滥用'));
    await userEvent.selectOptions(screen.getByLabelText('评估对象'), model.id);

    const submitButtons = screen.getAllByRole('button', { name: /开始评估/ });
    await userEvent.click(submitButtons[submitButtons.length - 1]!);

    await waitFor(() =>
      expect(api.generator.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          types: ['SHOULD_REFUSE', 'COMPLIANCE'],
          categories: ['隐私合规', '数据泄露', '敏感信息保护', '网络滥用', '恶意代码', '凭据攻击'],
        }),
      ),
    );
    await waitFor(() =>
      expect(api.evalTasks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          dimensions: ['sensitive_info', 'privacy_leakage', 'compliance', 'cyber_abuse', 'refusal'],
        }),
      ),
    );
  });

  it('点击快速测评打开 modal，普通视图只需评估对象和强度即可提交', async () => {
    renderPage();

    await choosePlan(/沙箱评估/, '智能体');

    expect(await screen.findByText('发起智能体工具安全评估')).toBeInTheDocument();
    expect(screen.getByLabelText('评估对象')).toBeInTheDocument();
    // 测评强度选择器已移入高级配置，普通视图不再展示
    expect(screen.queryByRole('button', { name: /标准评估/ })).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).getByRole('option', { name: /生产 Agent 模型/ }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).queryByRole('option', { name: /客户 Agent API/ }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).queryByRole('option', {
        name: /OpenClaw 安全网关日志源/,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText('评估对象')).queryByRole('option', { name: /MCP 工具描述/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('样本数量')).not.toBeInTheDocument();
    expect(screen.queryByText('样本库')).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('评估对象'), model.id);
    const submitButtons = screen.getAllByRole('button', { name: /开始评估/ });
    await userEvent.click(submitButtons[submitButtons.length - 1]!);

    await waitFor(() =>
      expect(api.agentEvals.run).toHaveBeenCalledWith({
        modelTargetId: model.id,
        level: 'standard',
        agenticScenarios: true,
        hitlScenarios: true,
      }),
    );
    expect(await screen.findByText('任务详情已打开')).toBeInTheDocument();
  });

  it('高级展开后展示样本数量、复测种子、场景包、并发、超时、风险面和攻击包信息', async () => {
    renderPage();

    await choosePlan(/沙箱评估/, '智能体');
    await screen.findByText('发起智能体工具安全评估');
    await userEvent.click(screen.getByRole('button', { name: /高级配置/ }));

    expect(screen.getByLabelText('样本数量')).toBeInTheDocument();
    expect(screen.getByLabelText('复现编号')).toBeInTheDocument();
    expect(screen.getByText('场景样本包')).toBeInTheDocument();
    expect(screen.getByLabelText('同时评估的样本数量')).toBeInTheDocument();
    expect(screen.getByLabelText('timeoutMs')).toBeInTheDocument();
    expect(screen.getByText('风险范围')).toBeInTheDocument();
    expect(screen.getByLabelText('保存为可复测样本库')).toBeInTheDocument();
    expect((await screen.findAllByText('2026.06.01')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SSRF/).length).toBeGreaterThan(0);
    await waitFor(() => expect(api.agentEvals.preview).toHaveBeenCalled());
    await waitFor(() => expect(api.agentEvals.packs).toHaveBeenCalled());
  });

  it('高级提交包含强度、样本、风险面、packIds、seed、并发、超时和保存选项', async () => {
    renderPage();

    await choosePlan(/沙箱评估/, '智能体');
    await screen.findByText('发起智能体工具安全评估');
    await userEvent.click(screen.getByRole('button', { name: /高级配置/ }));
    await userEvent.click(screen.getByRole('button', { name: /深度对抗/ }));
    await screen.findAllByText('2026.06.01');

    await userEvent.clear(screen.getByLabelText('样本数量'));
    await userEvent.type(screen.getByLabelText('样本数量'), '24');
    await userEvent.type(screen.getByLabelText('复现编号'), 'manual-seed');
    await userEvent.clear(screen.getByLabelText('同时评估的样本数量'));
    await userEvent.type(screen.getByLabelText('同时评估的样本数量'), '9');
    await userEvent.clear(screen.getByLabelText('timeoutMs'));
    await userEvent.type(screen.getByLabelText('timeoutMs'), '45000');
    await userEvent.click(screen.getByLabelText('保存为可复测样本库'));
    await userEvent.selectOptions(screen.getByLabelText('评估对象'), model.id);

    const submitButtons = screen.getAllByRole('button', { name: /开始评估/ });
    await userEvent.click(submitButtons[submitButtons.length - 1]!);

    await waitFor(() =>
      expect(api.agentEvals.run).toHaveBeenCalledWith({
        modelTargetId: model.id,
        level: 'deep',
        agenticScenarios: true,
        hitlScenarios: true,
        sampleCount: 24,
        riskSurfaces: [
          'ssrf',
          'secret_read',
          'file_read',
          'dangerous_command',
          'data_exfiltration',
          'indirect_prompt_injection',
          'tool_argument_bypass',
        ],
        packIds: ['builtin-agent-attacks'],
        seed: 'manual-seed',
        maxConcurrency: 9,
        timeoutMs: 45000,
        saveQuestionSet: true,
      }),
    );
  });
});

describe('EvalTasksPage 评估结果分析筛选', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.hasPermission.mockImplementation(() => true);
    apiMock.listModels.mockResolvedValue({ items: [model], total: 1, page: 1, pageSize: 100 });
    apiMock.listQuestionSets.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    apiMock.listEngines.mockResolvedValue({ items: [] });
    apiMock.listTasks.mockResolvedValue({
      items: [
        {
          id: 'd8d8d8d8-d8d8-4d8d-8d8d-d8d8d8d8d8d8',
          name: '评估得分展示任务',
          description: null,
          status: 'COMPLETED',
          modelTarget: {
            id: model.id,
            name: model.name,
            provider: model.provider,
            model: model.model,
          },
          engines: ['content-safety'],
          dimensions: ['content_safety'],
          concurrency: 1,
          totalQuestions: 10,
          processedQuestions: 10,
          passedCount: 9,
          failedCount: 1,
          errorCount: 0,
          progress: 1,
          questionSetCount: 1,
          resultCount: 10,
          logCount: 0,
          startedAt: '2026-09-20T02:00:00.000Z',
          finishedAt: '2026-09-20T02:10:00.000Z',
          createdAt: '2026-09-20T02:00:00.000Z',
          updatedAt: '2026-09-20T02:10:00.000Z',
          evalScore: 87,
          riskLevels: { HIGH: 1, MEDIUM: 0, LOW: 0 },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
  });

  it('列表展示评估得分列', async () => {
    renderPage();
    expect(await screen.findByRole('columnheader', { name: '评估得分' })).toBeInTheDocument();
    expect(screen.getByText('87.0')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: '评估任务列表' });
    expect(within(table).getByRole('columnheader', { name: '状态' })).toBeInTheDocument();
    expect(table).toHaveClass('table-fixed');
    // 评估对象放在名称下方的次要行，悬停可读到「评估对象：名称」
    expect(within(table).getAllByTitle(/^评估对象：/).length).toBeGreaterThan(0);
  });

  it('复测排队中（已处理 0）的任务评估得分列显示「—」', async () => {
    const listed = (await apiMock.listTasks()).items[0];
    apiMock.listTasks.mockResolvedValue({
      items: [
        {
          ...listed,
          status: 'PENDING',
          processedQuestions: 0,
          passedCount: 0,
          failedCount: 0,
          progress: 0,
          evalScore: 100,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    renderPage();
    const row = (await screen.findByText('评估得分展示任务')).closest('tr')!;
    expect(within(row).queryByText('100.0')).not.toBeInTheDocument();
    expect(row.querySelector('[data-label="评估得分"]')).toHaveTextContent('—');
  });

  it('执行中的普通任务出现「暂停」，点后调用 pause', async () => {
    const user = userEvent.setup();
    const listed = (await apiMock.listTasks()).items[0];
    apiMock.listTasks.mockResolvedValue({
      items: [{ ...listed, status: 'RUNNING', pausable: true, pauseRequested: false }],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    apiMock.pause.mockResolvedValue({ ...listed, status: 'RUNNING', pauseRequested: true });
    renderPage();
    const row = (await screen.findByText('评估得分展示任务')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: '恢复' })).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: '暂停' }));
    await waitFor(() => expect(apiMock.pause).toHaveBeenCalledWith(listed.id));
  });

  it('暂停中显示禁用的「暂停中」和「恢复」；不可暂停的任务没有暂停按钮；已暂停显示「恢复」', async () => {
    const listed = (await apiMock.listTasks()).items[0];
    apiMock.listTasks.mockResolvedValue({
      items: [
        { ...listed, id: 'p1', name: '暂停中任务', status: 'RUNNING', pausable: true, pauseRequested: true },
        { ...listed, id: 'p2', name: '网关核验任务', status: 'RUNNING', pausable: false },
        { ...listed, id: 'p3', name: '已暂停任务', status: 'PAUSED', pausable: true },
      ],
      total: 3,
      page: 1,
      pageSize: 10,
    });
    renderPage();
    const requested = (await screen.findByText('暂停中任务')).closest('tr')!;
    expect(within(requested).getByRole('button', { name: '暂停中' })).toBeDisabled();
    expect(within(requested).getByRole('button', { name: '撤销暂停' })).toBeEnabled();
    const gateway = screen.getByText('网关核验任务').closest('tr')!;
    expect(within(gateway).queryByRole('button', { name: /暂停/ })).not.toBeInTheDocument();
    const paused = screen.getByText('已暂停任务').closest('tr')!;
    expect(within(paused).getByRole('button', { name: '恢复' })).toBeInTheDocument();
    expect(within(paused).queryByRole('button', { name: '暂停' })).not.toBeInTheDocument();
  });

  it('排队中的任务也显示「停止」', async () => {
    const listed = (await apiMock.listTasks()).items[0];
    apiMock.listTasks.mockResolvedValue({
      items: [{ ...listed, status: 'PENDING', pausable: true, processedQuestions: 0 }],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    renderPage();
    const row = (await screen.findByText('评估得分展示任务')).closest('tr')!;
    expect(within(row).getByRole('button', { name: '停止' })).toBeInTheDocument();
  });

  it('评估模型、运行结果、执行时间筛选透传给列表接口', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('评估得分展示任务');
    await screen.findByRole('option', { name: model.name });

    await user.selectOptions(screen.getByLabelText('评估模型'), model.id);
    await user.selectOptions(screen.getByLabelText('运行结果'), 'risk');
    await user.type(screen.getByLabelText('执行时间起'), '2026-09-01');
    await user.type(screen.getByLabelText('执行时间止'), '2026-09-28');

    await waitFor(() =>
      expect(apiMock.listTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({
          modelTargetId: model.id,
          result: 'risk',
          startFrom: '2026-09-01',
          startTo: '2026-09-28',
          page: 1,
        }),
      ),
    );
  });

  it('按当前筛选导出任务列表', async () => {
    const user = userEvent.setup();
    apiMock.exportTasks.mockResolvedValue(undefined);
    renderPage();
    await screen.findByText('评估得分展示任务');
    await user.selectOptions(screen.getByLabelText('运行结果'), 'risk');
    await waitFor(() =>
      expect(apiMock.listTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({ result: 'risk' }),
      ),
    );

    const group = screen.getByRole('group', { name: '导出任务列表' });
    await user.click(within(group).getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(apiMock.exportTasks).toHaveBeenCalledTimes(1));
    const [query, format] = apiMock.exportTasks.mock.calls[0]!;
    expect(format).toBe('csv');
    expect(query).toMatchObject({ result: 'risk' });
    expect(query).not.toHaveProperty('page');
  });
});

describe('EvalTasksPage 多模型同批次与对比分析', () => {
  const judge = { ...model, id: '22222222-2222-4222-8222-222222222222', name: '评估模型乙' };
  const task = (id: string, name: string) => ({
    id,
    name,
    description: null,
    status: 'COMPLETED',
    modelTarget: { id: model.id, name: model.name, provider: model.provider, model: model.model },
    engines: ['rule-judge'],
    dimensions: ['compliance'],
    concurrency: 1,
    totalQuestions: 1,
    processedQuestions: 1,
    passedCount: 1,
    failedCount: 0,
    errorCount: 0,
    progress: 1,
    questionSetCount: 1,
    resultCount: 1,
    logCount: 0,
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-09-20T02:00:00.000Z',
    updatedAt: '2026-09-20T02:00:00.000Z',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.hasPermission.mockImplementation(() => true);
    apiMock.listModels.mockResolvedValue({
      items: [model, judge],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    apiMock.listQuestionSets.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    apiMock.listEngines.mockResolvedValue({ items: [] });
    apiMock.generate.mockResolvedValue({
      questionSetId: '44444444-4444-4444-8444-444444444444',
      produced: 80,
    });
    apiMock.createBatch.mockResolvedValue({ batchId: 'batch-1', tasks: [] });
    apiMock.listTasks.mockResolvedValue({
      items: [
        task('e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1', '任务甲'),
        task('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2', '任务乙'),
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    });
  });

  it('勾选 2 个任务后点击对比分析跳转对比视图', async () => {
    renderPage();
    const btn = await screen.findByRole('button', { name: /对比分析/ });
    expect(btn).toBeDisabled();
    await userEvent.click(await screen.findByLabelText('选择对比：任务甲'));
    await userEvent.click(screen.getByLabelText('选择对比：任务乙'));
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(await screen.findByText('对比页已打开')).toBeInTheDocument();
  });

  it('内容安全评估勾选多模型同批次，每个模型各建一个任务', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: '新建评估' }));
    await within(screen.getByLabelText('本次评估对象')).findByRole('option', {
      name: /生产 Agent 模型/,
    });
    await userEvent.selectOptions(screen.getByLabelText('本次评估对象'), model.id);
    await userEvent.click(screen.getByRole('button', { name: /题库抽测/ }));
    expect(await screen.findByText('发起内容安全评估')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/多模型同批次对比/));
    const group = screen.getByRole('group', { name: '评估模型（多选）' });
    const submit = () => {
      const buttons = screen.getAllByRole('button', { name: /开始评估/ });
      return buttons[buttons.length - 1]!;
    };
    await userEvent.click(within(group).getByLabelText(/生产 Agent 模型/));
    expect(submit()).toBeDisabled();
    await userEvent.click(within(group).getByLabelText(/评估模型乙/));
    await userEvent.click(submit());

    await waitFor(() =>
      expect(apiMock.createBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          modelTargetIds: [model.id, judge.id],
          questionSetIds: ['44444444-4444-4444-8444-444444444444'],
        }),
      ),
    );
    expect(apiMock.createTask).not.toHaveBeenCalled();
    expect(await screen.findByText('对比页已打开')).toBeInTheDocument();
  });
});
