import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';

const apiMock = vi.hoisted(() => ({
  overview: vi.fn(),
  builtinStats: vi.fn(),
  componentSecurity: vi.fn(),
  todos: vi.fn(),
  posture: vi.fn(),
  trend: vi.fn(),
  riskCategories: vi.fn(),
  changes: vi.fn(),
  ruleLibrary: vi.fn(),
  detectRisks: vi.fn(),
  permissions: null as Set<string> | null,
}));

vi.mock('@/lib/api', () => ({
  api: {
    dashboard: {
      overview: apiMock.overview,
      componentSecurity: apiMock.componentSecurity,
      todos: apiMock.todos,
      posture: apiMock.posture,
      trend: apiMock.trend,
      riskCategories: apiMock.riskCategories,
      changes: apiMock.changes,
      ruleLibrary: apiMock.ruleLibrary,
      detectRisks: apiMock.detectRisks,
    },
    questionSets: { builtinStats: apiMock.builtinStats },
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { username: 'admin', displayName: '超级管理员' },
    hasPermission: (code: string) => (apiMock.permissions ? apiMock.permissions.has(code) : true),
  }),
}));

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

/** 下钻后落到的页面：显示当前地址，便于断言跳转目标和参数。 */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const overview = {
  period: 'month',
  periodStart: '2026-09-01T00:00:00.000Z',
  counts: {
    taskTotal: 23,
    periodTaskCount: 9,
    modelTargetCount: 5,
    ownQuestionSetCount: 7,
    runQuestionSetCount: 20,
    tools: 4,
  },
  categories: [
    { category: 'redteam', label: '多轮对抗演练', count: 3 },
    { category: 'content', label: '内容安全评估', count: 6 },
  ],
  riskDistribution: { HIGH: 12, MEDIUM: 4, LOW: 2 },
  taskStatus: [{ status: 'COMPLETED', count: 8 }],
  taskTrend: [{ date: '2026-09-28', created: 2, completed: 1, failed: 0 }],
  recentTasks: [],
  readiness: [
    {
      taskId: 'task-1',
      taskName: '生产模型 多轮对抗',
      modelName: '生产模型',
      modelTargetId: 'mt-1',
      connectionState: 'ok',
      startStatus: '已启动',
      runStatus: 'COMPLETED',
      stages: [
        { key: 'target', label: '模型接入', state: 'done', detail: '连通性正常' },
        { key: 'questions', label: '样本库', state: 'done', detail: '20 条样本' },
        { key: 'start', label: '启动', state: 'done', detail: '已启动' },
        { key: 'run', label: '运行', state: 'done', detail: '已完成' },
        { key: 'review', label: '复核', state: 'active', detail: '待复核 3 项' },
        { key: 'report', label: '报告', state: 'pending', detail: '未生成' },
      ],
    },
  ],
  connectionIssues: { count: 0, untestedCount: 0 },
  topHighRiskTasks: [
    {
      id: 'task-1',
      name: '生产模型 多轮对抗',
      status: 'COMPLETED',
      modelName: '生产模型',
      createdAt: '2026-09-28T02:00:00.000Z',
      highRiskCount: 12,
      mediumRiskCount: 4,
      lowRiskCount: 2,
      evalScore: 61,
    },
  ],
};

/** 本月起点：北京时间 11-01 00:00。 */
const MONTH_START = '2026-10-31T16:00:00.000Z';
const ruleLibrary = { questionSets: 12, questions: 104012, keywords: 19581, agentSamples: 36 };
/** 首页下钻到风险处置台的地址：参数顺序同 drill.ts，排除误报（与首页计数口径一致）。 */
const riskHref = (p: Record<string, string> = {}) =>
  '/wrong-answers?' +
  new URLSearchParams({ ...p, reviewStatus: 'UNREVIEWED,NEEDS_REVIEW,CONFIRMED,ACCEPTED_RISK' });

const posture = {
  range: 'month',
  periodStart: MONTH_START,
  riskLevel: 'HIGH',
  riskLevelLabel: '高',
  score: 58,
  levelBasis: '存在 2 项严重风险、12 项高危风险',
  fewValid: false,
  severityCounts: { CRITICAL: 2, HIGH: 12, MEDIUM: 5, LOW: 3, INFO: 0 },
  facts: {
    tasksInitiated: 9,
    tasksCompleted: 7,
    findingTotal: 22,
    activeFindingTotal: 22,
    falsePositiveExcluded: 0,
    highCount: 14,
    criticalCount: 2,
    pendingReview: 6,
    pendingReviewTotal: 107,
    testItems: 420,
    validJudgements: 398,
  },
};
const trend = {
  days: 30,
  timezone: 'Asia/Shanghai',
  points: [
    { date: '2026-10-19', findings: 8, high: 2, pendingReview: 3 },
    { date: '2026-10-20', findings: 3, high: 1, pendingReview: 1 },
    { date: '2026-10-21', findings: 1, high: 0, pendingReview: 0 },
  ],
};
const categories = {
  range: 'month',
  periodStart: MONTH_START,
  total: 22,
  categoryCount: 2,
  items: [
    { key: 'agent_tool_abuse', label: '工具调用/越权代理风险', count: 9, high: 6, severity: {} },
    { key: 'prompt_injection', label: '提示词注入/越狱风险', count: 5, high: 3, severity: {} },
  ],
};
const changes = {
  newFindings: { current: 22, previous: 15, delta: 7 },
  highShare: { current: 0.6364, previous: 0.4, delta: 0.2364 },
  avgReviewHours: { current: null, previous: null, unavailableReason: '历史复核时间未留存' },
  previousUnavailableReason: null,
};
const todosOf = (n: {
  review?: number;
  remediation?: number;
  connection?: number;
  gate?: number;
  planning?: boolean;
}) => ({
  review: { count: n.review ?? 0, items: [] },
  remediation: { count: n.remediation ?? 0, items: [] },
  connection: { count: n.connection ?? 0, items: [] },
  gate: { count: n.gate ?? 0, items: [] },
  gates: { remediation: true, connection: true, planning: n.planning ?? false },
});

const riskCount = (total: number, high: number) => ({
  total,
  high,
  bySeverity: { CRITICAL: 0, HIGH: high, MEDIUM: total - high, LOW: 0, INFO: 0, UNRATED: 0 },
});
const detectRisks = {
  period: 'month',
  periodStart: MONTH_START,
  truncatedCorpusScans: 0,
  categories: [
    {
      category: 'model',
      label: '模型安全',
      total: 2,
      high: 1,
      sources: [{ source: 'model_file', label: '模型文件扫描发现', count: riskCount(2, 1) }],
    },
    {
      category: 'data',
      label: '数据安全',
      total: 3,
      high: 1,
      sources: [{ source: 'corpus', label: '语料扫描命中', count: riskCount(3, 1) }],
    },
    {
      category: 'content',
      label: '内容安全',
      total: 15,
      high: 9,
      sources: [{ source: 'eval_content', label: '内容评估风险项', count: riskCount(15, 9) }],
    },
    {
      category: 'app_env',
      label: '应用与环境安全',
      total: 6,
      high: 4,
      sources: [{ source: 'eval_app', label: '智能体与终端测评风险项', count: riskCount(6, 4) }],
    },
  ],
};

function mockAll() {
  apiMock.overview.mockResolvedValue(overview);
  apiMock.detectRisks.mockResolvedValue(detectRisks);
  apiMock.posture.mockResolvedValue(posture);
  apiMock.trend.mockResolvedValue(trend);
  apiMock.riskCategories.mockResolvedValue(categories);
  apiMock.changes.mockResolvedValue(changes);
  apiMock.ruleLibrary.mockResolvedValue(ruleLibrary);
  apiMock.todos.mockResolvedValue(todosOf({ review: 3, remediation: 2, connection: 1 }));
  apiMock.componentSecurity.mockResolvedValue({
    componentCount: 23,
    vulnerabilityCount: 9,
    baselineIssueCount: 4,
    runCount: 2,
  });
  apiMock.builtinStats.mockResolvedValue({
    builtinQuestionTotal: 1860,
    builtinSetCount: 3,
    ownSetCount: 7,
    categories: [
      { taxonomy: 'GBT45654', major: 'A.1 违反社会主义核心价值观', minor: 'x', count: 100 },
    ],
  });
}

describe('DashboardPage 态势概览', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAll();
  });

  it('展示态势摘要、快捷入口和真实业务信息', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: '态势概览' })).toBeInTheDocument();
    const entries = screen.getByRole('navigation', { name: '检测入口' });
    for (const label of ['多轮对抗演练', '内容安全评估', '合规专项检测', 'AI 组件漏洞扫描'])
      expect(within(entries).getByText(label)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '报告管理' })).toHaveAttribute('href', '/reports');
    expect(screen.getByRole('link', { name: '评估任务' })).toHaveAttribute('href', '/eval-tasks');
    // 侧栏「全部任务」是跨模块的检测记录（/detect-tasks），首页不再有同名入口指向评估任务。
    expect(screen.queryByRole('link', { name: '全部任务' })).not.toBeInTheDocument();
    expect(await screen.findByText('样本资产')).toBeInTheDocument();
    expect(screen.getAllByText('评估对象').length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: /待复核/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /接入异常/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /全部/ })).toBeInTheDocument();
    const region = await screen.findByRole('region', { name: '我的待办' });
    expect(await within(region).findByRole('link', { name: '待复核 3' })).toHaveAttribute(
      'href',
      '/my-todos',
    );
    expect(within(region).getByRole('link', { name: '待整改到期 2' })).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: '接入异常 1' })).toBeInTheDocument();
    expect(screen.queryByText(/TODO/)).not.toBeInTheDocument();
    // 旧的「检测流程」块已移除
    expect(screen.queryByText('检测流程')).not.toBeInTheDocument();
  });

  it('一句话态势、评分环与总体风险全部来自接口', async () => {
    renderPage();
    const hero = await screen.findByLabelText('总体风险态势');
    await waitFor(() => expect(within(hero).getByTestId('score-ring')).toBeInTheDocument());
    expect(within(hero).getByTestId('score-ring')).toHaveAttribute('aria-label', '综合评分 58 分');
    expect(within(hero).getByTestId('level-badge')).toHaveTextContent('总体风险：高');
    expect(hero).toHaveTextContent('本月已发起评估 9 项、完成 7 项');
    // 句子里的周期前缀一致：本月已发起 / 本月识别，不再「累计」「本月」混用
    expect(hero).toHaveTextContent('本月识别风险回复 22 条，其中高危 14 条需优先处置');
    expect(hero).not.toHaveTextContent('累计识别');
    expect(hero).toHaveTextContent('存在 2 项严重风险、12 项高危风险');
    // 新增风险回复变化：来自 changes；平均复核时长为 null，不显示
    expect(hero).toHaveTextContent('新增风险回复 +7');
    expect(within(hero).getByTestId('change-baseline')).toHaveTextContent('对比上月同期');
    expect(hero).toHaveTextContent('高危占比 63.6%');
    expect(hero).not.toHaveTextContent('平均复核时长');
  });

  it('任务页签按真实 readiness 数据筛选当前环节，并保留去复核入口', async () => {
    renderPage();
    await screen.findByRole('tab', { name: /待复核/ });
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText(/待复核 3 项/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '去复核' })).toHaveAttribute(
      'href',
      '/eval-tasks/task-1',
    );
    await userEvent.click(screen.getByRole('tab', { name: /全部/ }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByText('生产模型 多轮对抗').length).toBeGreaterThan(0);
  });

  it('风险等级分布、类别 Top、趋势图均渲染接口数据', async () => {
    renderPage();
    expect(await screen.findByText('工具调用/越权代理风险')).toBeInTheDocument();
    expect(screen.getByText('提示词注入/越狱风险')).toBeInTheDocument();
    expect(await screen.findByTestId('trend-chart')).toBeInTheDocument();
    expect(screen.getByText('54.5%')).toBeInTheDocument();
    expect(screen.getByText('9.1%')).toBeInTheDocument();
  });

  it('需要你处理：按真实数据生成行动项，已清零项合并展示', async () => {
    renderPage();
    expect(await screen.findByText('14 条高危回复待处置')).toBeInTheDocument();
    expect(screen.getByText('3 条风险回复待复核')).toBeInTheDocument();
    expect(screen.getByText('2 项整改临期或逾期')).toBeInTheDocument();
    expect(screen.getByText('1 个评估对象接入异常')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^处置/ })).toHaveAttribute('href', '/wrong-answers');
    expect(screen.getByRole('link', { name: /^复核/ })).toHaveAttribute('href', '/my-todos');
  });

  it('空的高风险数据展示空状态，不再出现空白「暂无数据」块', async () => {
    apiMock.overview.mockResolvedValue({
      ...overview,
      topHighRiskTasks: [],
      readiness: [],
      riskDistribution: { HIGH: 0, MEDIUM: 0, LOW: 0 },
    });
    renderPage();
    expect(await screen.findByText('暂无高风险任务')).toBeInTheDocument();
    expect((await screen.findAllByText('暂无数据')).length).toBeGreaterThan(0);
  });

  it('全空数据：各卡给出空状态且不显示虚假数字', async () => {
    apiMock.overview.mockResolvedValue({
      ...overview,
      counts: { taskTotal: 0, periodTaskCount: 0, modelTargetCount: 0, ownQuestionSetCount: 0 },
      taskStatus: [],
      topHighRiskTasks: [],
      readiness: [],
    });
    apiMock.posture.mockResolvedValue({
      ...posture,
      riskLevel: 'UNRATED',
      riskLevelLabel: '暂无法评级',
      score: null,
      levelBasis: '尚无有效判定',
      severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      facts: {
        ...posture.facts,
        tasksInitiated: 0,
        tasksCompleted: 0,
        findingTotal: 0,
        activeFindingTotal: 0,
        highCount: 0,
        criticalCount: 0,
      },
    });
    apiMock.trend.mockResolvedValue({
      ...trend,
      points: trend.points.map((p) => ({ ...p, findings: 0, high: 0, pendingReview: 0 })),
    });
    apiMock.riskCategories.mockResolvedValue({ total: 0, categoryCount: 0, items: [] });
    apiMock.changes.mockResolvedValue({ newFindings: null, highShare: null, avgReviewHours: null });
    apiMock.todos.mockResolvedValue(todosOf({}));
    apiMock.componentSecurity.mockResolvedValue({
      componentCount: 0,
      vulnerabilityCount: 0,
      baselineIssueCount: 0,
      runCount: 0,
    });
    renderPage();
    const hero = await screen.findByLabelText('总体风险态势');
    await waitFor(() =>
      expect(within(hero).getByTestId('level-badge')).toHaveTextContent('暂无法评级'),
    );
    expect(within(hero).queryByTestId('score-ring')).not.toBeInTheDocument();
    expect(hero).toHaveTextContent('尚未发起评估');
    expect(screen.getByText('本月暂无风险回复')).toBeInTheDocument();
    expect(screen.getByText('本月暂无风险类别数据')).toBeInTheDocument();
    expect(screen.getByText('近 30 天暂无风险回复')).toBeInTheDocument();
    expect(screen.getByText('暂无需要你处理的事项')).toBeInTheDocument();
    expect(screen.getByText('尚未扫描 AI 组件')).toBeInTheDocument();
  });

  it('切换统计周期同时驱动新旧接口', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '态势概览' });
    await userEvent.click(await screen.findByRole('button', { name: '近 7 天' }));
    expect(apiMock.overview).toHaveBeenLastCalledWith({ period: '7d' });
    await waitFor(() => {
      expect(apiMock.posture).toHaveBeenLastCalledWith({ range: '7d' });
      expect(apiMock.changes).toHaveBeenLastCalledWith({ range: '7d' });
      expect(apiMock.riskCategories).toHaveBeenLastCalledWith({ limit: 7, range: '7d' });
    });
    // 趋势固定近 30 天，不随范围变化
    expect(apiMock.trend).toHaveBeenLastCalledWith({ days: 30 });
  });

  it('局部失败只影响该卡，显示「加载失败 · 重试」且可重试', async () => {
    apiMock.riskCategories.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    // 风险类别排行和雷达图共用同一个接口，两张卡都显示重试，点哪个都重新请求一次。
    const retries = await screen.findAllByRole('button', { name: /加载失败 · 重试/ });
    expect(retries).toHaveLength(2);
    const retry = retries[0]!;
    // 其余卡片不受影响
    expect(screen.queryByText('提示词注入/越狱风险')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '态势概览' })).toBeInTheDocument();
    expect(await screen.findByText('14 条高危回复待处置')).toBeInTheDocument();
    await userEvent.click(retry);
    expect(await screen.findByText('提示词注入/越狱风险')).toBeInTheDocument();
    expect(apiMock.riskCategories).toHaveBeenCalledTimes(2);
  });
});

it('1 个接入异常对象挂多条任务时，评估对象卡与页签都按对象计 1；待测试单列', async () => {
  vi.clearAllMocks();
  mockAll();
  const failedStage = {
    key: 'target',
    label: '模型接入',
    state: 'failed',
    detail: '最近连通测试失败',
  };
  const untestedStage = {
    key: 'target',
    label: '模型接入',
    state: 'pending',
    detail: '未做连通测试',
  };
  const row = overview.readiness[0]!;
  const rows = [
    {
      ...row,
      taskId: 'a',
      taskName: '任务A',
      connectionState: 'failed',
      stages: [failedStage, ...row.stages.slice(1)],
    },
    {
      ...row,
      taskId: 'b',
      taskName: '任务B',
      connectionState: 'failed',
      stages: [failedStage, ...row.stages.slice(1)],
    },
    {
      ...row,
      taskId: 'c',
      taskName: '任务C',
      modelTargetId: 'mt-2',
      connectionState: 'untested',
      stages: [untestedStage, ...row.stages.slice(1)],
    },
  ];
  apiMock.overview.mockResolvedValue({
    ...overview,
    readiness: rows,
    connectionIssues: { count: 1, untestedCount: 1 },
  });
  renderPage();
  const tile = (await screen.findByText('评估对象', { selector: 'span' })).closest(
    'div',
  )!.parentElement!;
  expect(tile).toHaveTextContent('接入异常 1 · 待测试 1');
  const tab = screen.getByRole('tab', { name: /接入异常/ });
  expect(tab).toHaveTextContent('接入异常（1）');
  await userEvent.click(tab);
  expect(screen.getByText('任务A')).toBeInTheDocument();
  expect(screen.getByText('任务B')).toBeInTheDocument();
  expect(screen.queryByText('任务C')).not.toBeInTheDocument();
});

describe('DashboardPage 快速发起按写权限显示', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAll();
    apiMock.todos.mockResolvedValue(todosOf({}));
    apiMock.componentSecurity.mockResolvedValue({
      componentCount: 0,
      vulnerabilityCount: 0,
      baselineIssueCount: 0,
      runCount: 0,
    });
    apiMock.builtinStats.mockResolvedValue({
      builtinQuestionTotal: 0,
      builtinSetCount: 0,
      ownSetCount: 0,
      categories: [],
    });
  });
  afterEach(() => {
    apiMock.permissions = null;
  });

  it('只读账号看不到任何快速发起入口', async () => {
    apiMock.permissions = new Set(['eval_task:read', 'model_target:read', 'question_set:read']);
    renderPage();
    await screen.findByRole('heading', { name: '态势概览' });
    expect(screen.queryByRole('navigation', { name: '检测入口' })).not.toBeInTheDocument();
    for (const label of ['多轮对抗演练', '内容安全评估', '合规专项检测', 'AI 组件漏洞扫描']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
  });

  it('仅有 eval_task:create 时显示三个评估入口，不显示 AI 组件扫描', async () => {
    apiMock.permissions = new Set(['eval_task:read', 'eval_task:create']);
    renderPage();
    const entries = await screen.findByRole('navigation', { name: '检测入口' });
    for (const label of ['多轮对抗演练', '内容安全评估', '合规专项检测'])
      expect(within(entries).getByRole('link', { name: label })).toBeInTheDocument();
    expect(
      within(entries).queryByRole('link', { name: 'AI 组件漏洞扫描' }),
    ).not.toBeInTheDocument();
  });

  it('仅有 engine:scan 时只显示 AI 组件漏洞扫描', async () => {
    apiMock.permissions = new Set(['eval_task:read', 'engine:scan']);
    renderPage();
    const entries = await screen.findByRole('navigation', { name: '检测入口' });
    expect(within(entries).getByRole('link', { name: 'AI 组件漏洞扫描' })).toHaveAttribute(
      'href',
      '/ai-asset-scan',
    );
    expect(within(entries).queryByRole('link', { name: '多轮对抗演练' })).not.toBeInTheDocument();
  });

  it('无 eval_task:read 时显示无权限，不请求首页数据接口', async () => {
    apiMock.permissions = new Set(['engine:scan']);
    renderPage();
    expect(await screen.findByText('暂无访问权限')).toBeInTheDocument();
    expect(apiMock.overview).not.toHaveBeenCalled();
    expect(apiMock.posture).not.toHaveBeenCalled();
  });
});

describe('DashboardPage 门禁未过待办', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAll();
  });

  it('有门禁权限时显示真实门禁未过计数', async () => {
    apiMock.todos.mockResolvedValue(todosOf({ gate: 2, planning: true }));
    renderPage();
    const region = await screen.findByRole('region', { name: '我的待办' });
    const card = await within(region).findByRole('link', { name: '门禁未过 2' });
    expect(card).toHaveAttribute('href', '/eval/gates');
    expect(region).not.toHaveTextContent('TODO');
    expect(await screen.findByText('2 个上线门禁未通过')).toBeInTheDocument();
  });

  it('无门禁权限时不显示门禁块', async () => {
    apiMock.todos.mockResolvedValue(todosOf({ planning: false }));
    renderPage();
    const region = await screen.findByRole('region', { name: '我的待办' });
    await within(region).findByRole('link', { name: '待复核 0' });
    expect(region).not.toHaveTextContent('门禁');
  });

  it('零值卡显示绿色已清零文案，非零卡不显示', async () => {
    apiMock.todos.mockResolvedValue(todosOf({ review: 5, planning: true }));
    renderPage();
    const region = await screen.findByRole('region', { name: '我的待办' });
    await within(region).findByRole('link', { name: '待复核 5' });
    expect(within(region).getByText('均正常')).toBeInTheDocument();
    expect(within(region).getByText('无阻断')).toBeInTheDocument();
    expect(within(region).getAllByText('已清零').length).toBe(1);
  });

  it('只有待复核卡带趋势线，且悬停提示写明口径', async () => {
    apiMock.todos.mockResolvedValue(
      todosOf({ review: 5, remediation: 1, connection: 1, gate: 1, planning: true }),
    );
    renderPage();
    const region = await screen.findByRole('region', { name: '我的待办' });
    await within(region).findByRole('link', { name: '待复核 5' });
    expect(await within(region).findAllByTestId('sparkline')).toHaveLength(1);
    const svg = within(region).getByRole('img', { name: /当日新增且仍待复核/ });
    expect(svg).toBeInTheDocument();
  });
});

describe('DashboardPage 规则库统计（2.2.1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAll();
  });
  afterEach(() => {
    apiMock.permissions = null;
  });

  it('规则库卡片显示题集、题目、关键词、智能体样本并可跳到对应库', async () => {
    renderPage();
    const card = await screen.findByRole('region', { name: '规则库' });
    expect(await within(card).findByRole('link', { name: '题集 12' })).toHaveAttribute(
      'href',
      '/question-sets',
    );
    expect(within(card).getByRole('link', { name: '题目 104,012' })).toHaveAttribute(
      'href',
      '/question-sets',
    );
    expect(within(card).getByRole('link', { name: '关键词 19,581' })).toHaveAttribute(
      'href',
      '/question-sets?tab=keyword',
    );
    expect(within(card).getByRole('link', { name: '智能体样本 36' })).toHaveAttribute(
      'href',
      '/agent-samples',
    );
  });

  it('规则库单独取，切换统计周期不重新请求', async () => {
    renderPage();
    const card = await screen.findByRole('region', { name: '规则库' });
    await within(card).findByRole('link', { name: '题集 12' });
    await userEvent.click(screen.getByRole('button', { name: '近 7 天' }));
    await waitFor(() => expect(apiMock.overview).toHaveBeenLastCalledWith({ period: '7d' }));
    await userEvent.click(screen.getByRole('button', { name: '全部' }));
    await waitFor(() => expect(apiMock.overview).toHaveBeenLastCalledWith({ period: 'all' }));
    expect(apiMock.ruleLibrary).toHaveBeenCalledTimes(1);
  });

  it('样本资产与「规则库 · 题目」同口径，副标题不再重复题集套数', async () => {
    renderPage();
    const hero = await screen.findByLabelText('总体风险态势');
    const tile = await within(hero).findByRole('link', { name: /^样本资产/ });
    await waitFor(() => expect(tile).toHaveTextContent('104,012'));
    expect(tile).toHaveTextContent('运行记录 20 条');
    expect(tile).not.toHaveTextContent('内置');
    expect(tile).not.toHaveTextContent('自有');
    expect(apiMock.builtinStats).not.toHaveBeenCalled();
  });

  it('没有对应库的查看权限时只显示数字，不给链接', async () => {
    apiMock.permissions = new Set(['eval_task:read']);
    renderPage();
    const card = await screen.findByRole('region', { name: '规则库' });
    expect(await within(card).findByText('104,012')).toBeInTheDocument();
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();
  });
});

const manyCategories = {
  range: 'month',
  periodStart: MONTH_START,
  total: 35,
  categoryCount: 7,
  items: [
    ['agent_tool_abuse', '工具调用/越权代理风险', 9],
    ['prompt_injection', '提示词注入/越狱风险', 7],
    ['privacy_leakage', '隐私与敏感信息泄露风险', 6],
    ['data_exfiltration', '数据外传/越权披露风险', 5],
    ['cyber_abuse', '网络滥用/恶意代码风险', 4],
    ['legal_compliance', '违法违规/合规风险', 3],
    ['model_theft', '模型盗用/能力探测风险', 1],
  ].map(([key, label, count]) => ({ key, label, count, high: 0, severity: {} })),
};

describe('DashboardPage 饼图与雷达图（2.2.3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAll();
  });

  it('风险等级分布用环形图，扇区取自等级分布', async () => {
    renderPage();
    const donut = await screen.findByRole('group', { name: '风险等级分布' });
    expect(
      within(donut)
        .getAllByRole('img')
        .map((el) => el.getAttribute('aria-label')),
    ).toEqual(['严重 2', '高危 12', '中危 5', '低危 3']);
  });

  it('风险类别雷达图取风险类别接口的前 6 类', async () => {
    apiMock.riskCategories.mockResolvedValue(manyCategories);
    renderPage();
    const card = await screen.findByRole('region', { name: '风险类别雷达' });
    await within(card).findByRole('group', { name: '风险类别雷达图' });
    expect(card.querySelectorAll('.recharts-polar-angle-axis-tick')).toHaveLength(6);
    expect(within(card).queryByText(/模型盗用/)).not.toBeInTheDocument();
  });

  it('没有数据时不渲染空图：等级分布显示空状态，雷达卡不出', async () => {
    apiMock.riskCategories.mockResolvedValue({ total: 0, categoryCount: 0, items: [] });
    apiMock.posture.mockResolvedValue({
      ...posture,
      severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    });
    renderPage();
    expect(await screen.findByText('本月暂无风险类别数据')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '风险类别雷达' })).not.toBeInTheDocument();
    expect(await screen.findByText('本月暂无风险回复')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '风险等级分布' })).not.toBeInTheDocument();
  });

  it('类别少于 3 个时不渲染雷达卡，排行卡占满整行', async () => {
    renderPage();
    expect(await screen.findByText('提示词注入/越狱风险')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '风险类别雷达' })).not.toBeInTheDocument();
    expect(screen.getByTestId('category-row')).not.toHaveClass('xl:grid-cols-2');
  });

  it('类别有 3 个及以上时雷达卡与排行卡并排', async () => {
    apiMock.riskCategories.mockResolvedValue({
      ...manyCategories,
      items: manyCategories.items.slice(0, 3),
    });
    renderPage();
    const card = await screen.findByRole('region', { name: '风险类别雷达' });
    await within(card).findByRole('group', { name: '风险类别雷达图' });
    expect(screen.getByTestId('category-row')).toHaveClass('xl:grid-cols-2');
  });
});

describe('DashboardPage 下钻（2.2.4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAll();
  });
  afterEach(() => {
    apiMock.permissions = null;
  });

  it('4 个统计数字都可以点击，跳到对应列表页', async () => {
    renderPage();
    const hero = await screen.findByLabelText('总体风险态势');
    const tile = (name: RegExp) => within(hero).getByRole('link', { name });
    await waitFor(() => expect(tile(/^评估任务/)).toHaveAttribute('href', '/eval-tasks'));
    expect(tile(/^风险回复/)).toHaveAttribute('href', riskHref({ since: MONTH_START }));
    expect(tile(/^评估对象/)).toHaveAttribute('href', '/model-targets');
    expect(tile(/^样本资产/)).toHaveAttribute('href', '/question-sets');
  });

  it('工具数（2.2.1）可点击，跳到工具中心；没有工具中心权限时不显示', async () => {
    const { unmount } = renderPage();
    const hero = await screen.findByLabelText('总体风险态势');
    const tools = await within(hero).findByRole('link', { name: /^工具/ });
    expect(tools).toHaveAttribute('href', '/tools');
    expect(tools).toHaveTextContent('4');
    unmount();
    apiMock.overview.mockResolvedValue({
      ...overview,
      counts: { ...overview.counts, tools: null },
    });
    renderPage();
    const hero2 = await screen.findByLabelText('总体风险态势');
    await within(hero2).findByRole('link', { name: /^样本资产/ });
    expect(within(hero2).queryByRole('link', { name: /^工具/ })).not.toBeInTheDocument();
  });

  it('点等级分布的扇区，跳到风险处置台并带等级、周期起点，排除误报', async () => {
    renderPage();
    const donut = await screen.findByRole('group', { name: '风险等级分布' });
    await userEvent.click(within(donut).getByRole('img', { name: '高危 12' }));
    expect(await screen.findByTestId('location')).toHaveTextContent(
      riskHref({ severity: 'HIGH', since: MONTH_START }),
    );
  });

  it('等级分布的图例也是链接，带等级参数', async () => {
    renderPage();
    expect(await screen.findByRole('link', { name: /^严重 2/ })).toHaveAttribute(
      'href',
      riskHref({ severity: 'CRITICAL', since: MONTH_START }),
    );
  });

  it('统计周期为「全部」时下钻不带日期', async () => {
    apiMock.posture.mockImplementation(async ({ range }: { range: string }) => ({
      ...posture,
      range,
      periodStart: range === 'all' ? null : MONTH_START,
    }));
    apiMock.riskCategories.mockImplementation(async ({ range }: { range: string }) => ({
      ...categories,
      range,
      periodStart: range === 'all' ? null : MONTH_START,
    }));
    renderPage();
    await screen.findByRole('link', { name: /^严重 2/ });
    await userEvent.click(screen.getByRole('button', { name: '全部' }));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /^严重 2/ })).toHaveAttribute(
        'href',
        riskHref({ severity: 'CRITICAL' }),
      ),
    );
    await waitFor(() => {
      const link = screen
        .getAllByRole('link', { name: '工具调用/越权代理风险 9' })
        .find((el) => el.tagName === 'A');
      expect(link).toHaveAttribute('href', riskHref({ domain: 'agent_tool_abuse' }));
    });
  });

  it('类别分布的行可以点，跳到风险处置台并带类别', async () => {
    renderPage();
    const links = await screen.findAllByRole('link', { name: '工具调用/越权代理风险 9' });
    expect(links.find((el) => el.tagName === 'A')).toHaveAttribute(
      'href',
      riskHref({ domain: 'agent_tool_abuse', since: MONTH_START }),
    );
  });

  it('点雷达图的顶点，跳到风险处置台并带类别', async () => {
    apiMock.riskCategories.mockResolvedValue(manyCategories);
    renderPage();
    const radar = await screen.findByRole('region', { name: '风险类别雷达' });
    await userEvent.click(
      await within(radar).findByRole('link', { name: '提示词注入/越狱风险 7' }),
    );
    expect(await screen.findByTestId('location')).toHaveTextContent(
      riskHref({ domain: 'prompt_injection', since: MONTH_START }),
    );
  });

  // 趋势按北京时间自然日统计：10-20 这天 = [10-19T16:00Z, 10-20T16:00Z)。
  const DAY_1020 = { since: '2026-10-19T16:00:00.000Z', until: '2026-10-20T16:00:00.000Z' };

  it('点趋势图上的某天，跳到风险处置台并带当天 0 点到次日 0 点', async () => {
    renderPage();
    const svg = await screen.findByRole('img', { name: /风险回复共 12 条/ });
    svg.getBoundingClientRect = () => ({
      left: 0,
      width: 640,
      top: 0,
      height: 250,
      right: 640,
      bottom: 250,
      x: 0,
      y: 0,
      toJSON() {},
    });
    fireEvent.click(svg, { clientX: 320 });
    expect(await screen.findByTestId('location')).toHaveTextContent(riskHref(DAY_1020));
  });

  it('趋势图每天可用键盘聚焦，回车或空格下钻', async () => {
    const { unmount } = renderPage();
    const day = await screen.findByRole('link', { name: '10/20 风险回复 3 条' });
    day.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByTestId('location')).toHaveTextContent(riskHref(DAY_1020));
    unmount();
    renderPage();
    const first = await screen.findByRole('link', { name: '10/19 风险回复 8 条' });
    first.focus();
    await userEvent.keyboard(' ');
    expect(await screen.findByTestId('location')).toHaveTextContent(
      riskHref({ since: '2026-10-18T16:00:00.000Z', until: '2026-10-19T16:00:00.000Z' }),
    );
  });

  it('没有风险处置台权限时，等级、类别、趋势和风险回复都不跳风险处置台', async () => {
    apiMock.permissions = new Set(['eval_task:read', 'model_target:read', 'question_set:read']);
    apiMock.riskCategories.mockResolvedValue(manyCategories);
    renderPage();
    const radar = await screen.findByRole('region', { name: '风险类别雷达' });
    await within(radar).findByRole('group', { name: '风险类别雷达图' });
    await screen.findByRole('group', { name: '风险等级分布' });
    const toRisk = screen
      .queryAllByRole('link')
      .filter((el) => el.getAttribute('href')?.startsWith('/wrong-answers'));
    expect(toRisk).toHaveLength(0);
    expect(within(radar).queryByRole('link')).not.toBeInTheDocument();
    const trend = screen.getByTestId('trend-chart');
    expect(within(trend).queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(within(trend).getByRole('img'), { clientX: 320 });
    await userEvent.click(screen.getByRole('img', { name: '高危 12' }));
    expect(screen.queryByTestId('location')).not.toBeInTheDocument();
  });
});

describe('DashboardPage 四类风险（2.2.2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAll();
  });
  afterEach(() => {
    apiMock.permissions = null;
  });

  it('卡片在接口返回后出现，按统计周期取数；与安全态势的差额写明原因', async () => {
    renderPage();
    const card = await screen.findByRole('region', { name: '四类风险' });
    expect(await within(card).findByRole('link', { name: /^数据安全/ })).toHaveAttribute(
      'href',
      `/analysis/results?category=data&since=${encodeURIComponent(MONTH_START)}`,
    );
    expect(apiMock.detectRisks).toHaveBeenLastCalledWith({ period: 'month' });
    // 安全态势 22 条，评估类 15 + 6 = 21 条
    expect(
      await within(card).findByText(
        '评估类比安全态势「风险回复」（已扣误报）少 1 条：终端体检通过项不计入',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '近 7 天' }));
    await waitFor(() => expect(apiMock.detectRisks).toHaveBeenLastCalledWith({ period: '7d' }));
  });

  it('没有评估任务权限但能看语料扫描时，仍显示四类风险', async () => {
    apiMock.permissions = new Set(['corpus_scan:read']);
    renderPage();
    expect(await screen.findByText('暂无访问权限')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: '四类风险' })).toBeInTheDocument();
    expect(apiMock.overview).not.toHaveBeenCalled();
  });

  it('一个来源的权限都没有时不显示，也不请求', async () => {
    apiMock.permissions = new Set(['tool:read']);
    renderPage();
    expect(await screen.findByText('暂无访问权限')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '四类风险' })).not.toBeInTheDocument();
    expect(apiMock.detectRisks).not.toHaveBeenCalled();
  });
});
