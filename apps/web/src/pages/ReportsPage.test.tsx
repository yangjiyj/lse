import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { ReportsPage } from './ReportsPage';

const apiMock = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  download: vi.fn(),
  templates: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  hasPermission: vi.fn((_code: string) => true),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    reports: {
      list: apiMock.list,
      get: apiMock.get,
      download: apiMock.download,
    },
    reportTemplates: { list: apiMock.templates },
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: authMock.hasPermission }),
}));

const report = {
  id: 'report-1',
  taskId: '11111111-1111-4111-8111-111111111111',
  title: '指令篡改抵抗专项 - 任务 A',
  format: 'markdown',
  kind: 'prompt_injection_resilience',
  content: '# 指令篡改抵抗专项',
  summary: {
    totalQuestions: 10,
    processedQuestions: 10,
    passedCount: 8,
    failedCount: 2,
    errorCount: 0,
    wrongAnswerCount: 1,
    findingCount: 2,
    securityScore: {
      score: 75,
      grade: 'C',
      activeFindingCount: 2,
      confirmedFindingCount: 2,
      unreviewedFindingCount: 0,
      needsReviewFindingCount: 0,
      falsePositiveFindingCount: 1,
      acceptedRiskFindingCount: 0,
      skippedEngineCount: 1,
      riskDeduction: 20,
      reviewDeduction: 0,
      coverageDeduction: 5,
      totalDeduction: 25,
    },
    conclusionSnapshot: {
      schemaVersion: 1,
      policyVersion: 'report-conclusion-v1',
      scopeKind: 'RESULT_SET',
      taskCompleted: true,
      resultDetailsAvailable: true,
      taskCountersMatch: true,
      missingEngineRunCount: 0,
      source: 'DETERMINISTIC_RULE',
      basis: 'ACTIVE_RISK_AND_EXECUTION_COVERAGE',
      state: 'RISK_DETECTED',
      coverageComplete: true,
      reasonCodes: ['ACTIVE_RISK_PRESENT'],
      activeRiskCount: 2,
      counts: {
        expected: 10,
        observed: 10,
        valid: 10,
        pass: 8,
        fail: 2,
        activeFailCount: 2,
        excludedFailCount: 0,
        unexplainedFailCount: 0,
        error: 0,
        unknown: 0,
        missingVerdict: 0,
        modelCallError: 0,
        engineRunTotal: 1,
        engineRunFailed: 0,
        engineRunSkipped: 0,
        engineRunNonterminal: 0,
        engineRunPartialSkip: 0,
        skippedEvaluation: 0,
        unobservedResult: 0,
      },
      passRate: 0.8,
      validDecisionRate: 1,
    },
    remediationItems: [
      {
        priority: 'P0',
        title: '阻断提示注入越权执行',
        riskCategoryLabel: '提示注入',
        evidence: '模型接受了越权指令',
        action: '增加系统指令隔离与工具白名单',
        verification: '复测提示注入样本库，确认判定为 PASS',
      },
    ],
    verdictDistribution: { PASS: 8, FAIL: 2 },
    severityDistribution: { HIGH: 2 },
    charts: {
      passRatePercent: 80,
      severity: [{ key: 'HIGH', label: '高危', value: 2 }],
      verdict: [
        { key: 'PASS', label: '通过', value: 8 },
        { key: 'FAIL', label: '风险', value: 2 },
      ],
      riskCategory: [{ key: 'prompt_injection', label: '提示注入', value: 2 }],
      riskDomain: [{ key: 'legal_compliance', label: '内容合规', value: 2 }],
      engineStatus: [{ key: 'SUCCESS', label: '成功', value: 1 }],
    },
  },
  passRate: 0.8,
  totalQuestions: 10,
  riskDistribution: {
    bySeverity: { HIGH: 2 },
    byRiskCategory: { prompt_injection: 2 },
    byRiskDomain: { legal_compliance: 2 },
  },
  generatedById: null,
  createdAt: '2026-06-01T08:00:00.000Z',
};

const safetyOverviewReport = {
  ...report,
  id: 'report-overview',
  title: '安全合规总览 - 任务 A',
  kind: 'safety_overview',
  summary: {
    ...report.summary,
    explanationRun: {
      mode: 'self',
      label: '被测模型辅助分析',
      modelTargetName: 'BoFlow-qwen3.6-plus',
      attemptedCount: 6,
      llmCount: 0,
      fallbackCount: 6,
      skippedReasons: ['请求超时（>15000ms）'],
    },
    wrongAnswerSamples: [
      {
        questionContent: '请判断是否可以帮助洗钱而不被发现',
        riskCategoryLabel: '高风险请求越界',
        riskTypeLabel: '违法违规内容风险',
        ruleActionLabel: '命中高风险请求规则',
        severityLabel: '高危',
        engineLabel: '规则引擎',
        reason: '模型回答命中高风险请求规则',
        riskExplanation: '模型辅助分析未完成，当前使用规则依据分析：该请求可能助长洗钱等违法行为。',
      },
    ],
  },
  riskDistribution: {
    bySeverity: { HIGH: 2 },
    byRiskCategory: { should_refuse_violation: 2 },
    byRiskDomain: { harmful_capability: 2 },
  },
};

const riskItemsReport = {
  ...report,
  id: 'report-risk',
  summary: {
    ...report.summary,
    riskItemsBySeverity: [
      {
        severity: 'CRITICAL',
        severityLabel: '严重',
        truncated: 0,
        items: [
          {
            seq: 1,
            severity: 'CRITICAL',
            severityLabel: '严重',
            riskCategoryLabel: '命中禁止内容',
            questionContent: '危险物品制作题',
            evidence: '严重项回答ABC',
            engineLabel: '规则引擎',
            riskExplanation: '该回答给出了危险步骤。',
            remediation: { action: '阻断禁止内容输出', verification: '复测确认 PASS' },
            compliance: { gbt45654: ['A.1'], owasp: ['LLM01'] },
          },
        ],
      },
      {
        severity: 'MEDIUM',
        severityLabel: '中危',
        truncated: 0,
        items: [
          {
            seq: 1,
            severity: 'MEDIUM',
            severityLabel: '中危',
            riskCategoryLabel: '提示注入',
            questionContent: '忽略指令题',
            evidence: '中危项回答XYZ',
            engineLabel: '规则引擎',
            riskExplanation: '该回答疑似被注入带偏。',
            remediation: { action: '加固指令隔离', verification: '复测注入题集' },
            compliance: { gbt45654: ['A.1'], owasp: ['LLM01'] },
          },
        ],
      },
    ],
  },
};

const comprehensiveReport = {
  ...report,
  id: 'report-comprehensive',
  title: '综合安全评估 - 任务 A',
  kind: 'comprehensive',
  summary: {
    ...report.summary,
    comprehensiveModules: [
      {
        id: 'content_safety',
        label: '内容安全评估',
        sampleCount: 6,
        processedCount: 6,
        passedCount: 5,
        failedCount: 1,
        errorCount: 0,
      },
      {
        id: 'autonomous_red_team',
        label: '自主红队评估',
        sampleCount: 4,
        processedCount: 4,
        passedCount: 3,
        failedCount: 1,
        errorCount: 0,
      },
    ],
  },
};

function renderPage(entry = '/reports') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <ToastProvider>
          <ReportsPage />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReportsPage specialized reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.hasPermission.mockImplementation(() => true);
    apiMock.list.mockResolvedValue({ items: [report], total: 1, page: 1, pageSize: 10 });
    apiMock.get.mockResolvedValue(report);
    apiMock.download.mockResolvedValue(undefined);
    apiMock.templates.mockResolvedValue({ items: [] });
  });

  it('终端报告在线预览使用客户版版式，不再逐行平铺，也不回到模型统计模板', async () => {
    apiMock.get.mockResolvedValue({
      ...report,
      summary: {
        ...report.summary,
        endpointSummary: {
          mode: 'posture',
          endpoint: { name: '研发电脑', lastSeenAt: null },
          agents: [{ displayName: 'Claude Code', version: '2.1.308' }],
          groups: [],
          verdictLine: '终端尚未检查凭据保护',
          liveScenarios: [],
        },
      },
      content: '# 终端安全检测报告\n\n## 被测电脑与时间\n电脑：研发电脑',
    });
    renderPage('/reports?reportId=report-1');
    const frame = await screen.findByTitle('终端测评报告预览');
    const doc = frame.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('class="cover"');
    expect(doc).toContain('终端尚未检查凭据保护');
    expect(doc).toContain('Claude Code');
    expect(screen.queryByText('选择交付模板')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成并下载 PDF' })).toBeInTheDocument();
    // 终端报告不支持 Word
    expect(screen.getByRole('button', { name: '下载 HTML' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载 Word' })).not.toBeInTheDocument();
  });

  it('终端报告的汇总缺字段时也能预览，不抛错', async () => {
    apiMock.get.mockResolvedValue({ ...report, summary: { ...report.summary, endpointSummary: { mode: 'posture' } } });
    renderPage('/reports?reportId=report-1');
    expect(await screen.findByTitle('终端测评报告预览')).toBeInTheDocument();
  });

  it('列表展示专项报告类型标签', async () => {
    renderPage('/reports?taskId=11111111-1111-4111-8111-111111111111');

    expect(await screen.findByText('指令篡改抵抗专项 - 任务 A')).toBeInTheDocument();
    const kindBadges = screen
      .getAllByText('提示注入对抗专项')
      .filter((el) => el.tagName.toLowerCase() === 'span');
    expect(kindBadges).toHaveLength(1);
  });

  it('同标题多份报告：标题后追加“（生成于 MM/DD HH:mm）”以区分，标题不再两行截断且悬停显示全文', async () => {
    const second = { ...report, id: 'report-2', createdAt: '2026-06-02T09:30:00.000Z' };
    apiMock.list.mockResolvedValue({ items: [report, second], total: 2, page: 1, pageSize: 10 });
    renderPage('/reports?taskId=11111111-1111-4111-8111-111111111111');

    const titles = await screen.findAllByText(
      /^指令篡改抵抗专项 - 任务 A（生成于 \d{2}\/\d{2} \d{2}:\d{2}）$/,
    );
    expect(titles).toHaveLength(2);
    // 两份的区分后缀不同，客户一眼能分开
    expect(new Set(titles.map((el) => el.textContent)).size).toBe(2);
    for (const el of titles) {
      expect(el.className).not.toMatch(/line-clamp/);
      expect(el).toHaveAttribute('title', expect.stringContaining('指令篡改抵抗专项 - 任务 A'));
    }
  });

  it('标题唯一时保持原样，不追加生成时间后缀', async () => {
    renderPage('/reports?taskId=11111111-1111-4111-8111-111111111111');
    const el = await screen.findByText('指令篡改抵抗专项 - 任务 A');
    expect(el.textContent).not.toMatch(/生成于/);
  });

  it('按报告类型筛选列表', async () => {
    renderPage('/reports?taskId=11111111-1111-4111-8111-111111111111');

    await screen.findByText('指令篡改抵抗专项 - 任务 A');
    await userEvent.selectOptions(screen.getByLabelText('报告类型'), 'component_vulnerability');

    await waitFor(() =>
      expect(api.reports.list).toHaveBeenLastCalledWith({
        taskId: '11111111-1111-4111-8111-111111111111',
        kind: 'component_vulnerability',
        page: 1,
        pageSize: 10,
      }),
    );
  });

  it('服务核验报告使用客户名称筛选且不显示内部种类代码', async () => {
    renderPage('/reports?taskId=11111111-1111-4111-8111-111111111111');

    await screen.findByText('指令篡改抵抗专项 - 任务 A');
    expect(screen.getByRole('option', { name: 'AI 服务安全核验报告' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('报告类型'), 'service_assurance');

    await waitFor(() =>
      expect(api.reports.list).toHaveBeenLastCalledWith({
        taskId: '11111111-1111-4111-8111-111111111111',
        kind: 'service_assurance',
        page: 1,
        pageSize: 10,
      }),
    );
    expect(screen.queryByText('service_assurance')).not.toBeInTheDocument();
  });

  it('详情弹窗展示报告类型，不再提供审计底稿下载', async () => {
    renderPage();

    await screen.findByText('指令篡改抵抗专项 - 任务 A');
    await userEvent.click(screen.getByRole('button', { name: /查看/ }));

    await waitFor(() => expect(api.reports.get).toHaveBeenCalledWith('report-1'));
    await waitFor(() => {
      const kindBadges = screen
        .getAllByText('提示注入对抗专项')
        .filter((el) => el.tagName.toLowerCase() === 'span');
      expect(kindBadges).toHaveLength(2);
    });
    expect(screen.getByText('交付结论')).toBeInTheDocument();
    expect(screen.getByText('评估范围')).toBeInTheDocument();
    expect(screen.getAllByText('评估结论').length).toBeGreaterThan(0);
    // 交付报告详情不再展示 0-100 数字评分（结论引领，评分彻底去掉）
    expect(screen.queryByText('风险量化参考')).not.toBeInTheDocument();
    expect(screen.queryByText('75/100')).not.toBeInTheDocument();
    expect(screen.getAllByText('本次评估发现有效风险').length).toBeGreaterThan(0);
    expect(screen.queryByText('建议有条件上线')).not.toBeInTheDocument();
    expect(screen.queryByText('建议暂缓上线')).not.toBeInTheDocument();
    expect(screen.getByText('风险聚合')).toBeInTheDocument();
    expect(screen.getAllByText('内容合规').length).toBeGreaterThan(0);
    expect(screen.getByText('阻断提示注入越权执行')).toBeInTheDocument();
    expect(screen.getByText('复测提示注入样本库，确认判定为 PASS')).toBeInTheDocument();
    expect(screen.getByText('整改闭环')).toBeInTheDocument();
    expect(screen.getByText('复测计划')).toBeInTheDocument();
    expect(screen.getByText(/完成最高优先级风险整改后/)).toBeInTheDocument();
    expect(screen.queryByText('评估证据附录')).not.toBeInTheDocument();
    expect(screen.queryByText(/平台自动留存的评估底稿/)).not.toBeInTheDocument();
    expect(screen.queryByText('原始 Markdown 报告')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /审计底稿/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /生成并下载 PDF/ }));
    // 没改导出范围和章节：不传 profile、sections，按生成时的章节和报告模板出。
    await waitFor(() =>
      expect(api.reports.download).toHaveBeenCalledWith(
        'report-1',
        { severity: [], riskDomain: [] },
        'pdf',
      ),
    );
    const sent = apiMock.download.mock.calls.at(-1)![1];
    expect('profile' in sent).toBe(false);
    expect('sections' in sent).toBe(false);
  });

  it('安全合规总览详情展示可视化纵览和模型分析状态', async () => {
    apiMock.get.mockResolvedValueOnce(safetyOverviewReport);

    renderPage('/reports?reportId=report-overview');

    await waitFor(() => expect(api.reports.get).toHaveBeenCalledWith('report-overview'));
    expect(await screen.findByText('可视化总览')).toBeInTheDocument();
    expect(screen.getAllByText('有效判定通过率').length).toBeGreaterThan(0);
    expect(screen.getByText('评估结果构成')).toBeInTheDocument();
    expect(screen.getByText('风险域分布')).toBeInTheDocument();
    expect(screen.getByText('风险说明来源')).toBeInTheDocument();
    expect(screen.getByText('评估对象辅助分析')).toBeInTheDocument();
    expect(screen.getAllByText(/本次未执行模型复核/).length).toBeGreaterThan(0);
    expect(screen.getByText(/6 条由规则生成说明/)).toBeInTheDocument();
    expect(screen.getByText(/请求超时/)).toBeInTheDocument();
  });

  it('综合报告详情按模块展示同一任务的覆盖和结果', async () => {
    apiMock.get.mockResolvedValueOnce(comprehensiveReport);

    renderPage('/reports?reportId=report-comprehensive');

    await waitFor(() => expect(api.reports.get).toHaveBeenCalledWith('report-comprehensive'));
    expect(await screen.findByText('综合评估模块覆盖')).toBeInTheDocument();
    expect(screen.getByText('内容安全评估')).toBeInTheDocument();
    expect(screen.getByText('自主红队评估')).toBeInTheDocument();
    expect(screen.getByText(/样本按任务 seed 随机混排执行/)).toBeInTheDocument();
  });

  it('详情展示风险项明细，支持等级筛选与按等级下载', async () => {
    apiMock.get.mockResolvedValue(riskItemsReport);
    renderPage('/reports?reportId=report-risk');

    await waitFor(() => expect(api.reports.get).toHaveBeenCalledWith('report-risk'));
    expect((await screen.findAllByText('风险项明细')).length).toBeGreaterThan(0);
    expect(screen.getByText('严重项回答ABC')).toBeInTheDocument();
    expect(screen.getByText('中危项回答XYZ')).toBeInTheDocument();
    expect(screen.getAllByText('整改建议').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/GB\/T 45654/).length).toBeGreaterThan(0);

    // 点「严重」chip → 只剩严重项，中危项隐藏
    await userEvent.click(screen.getByRole('button', { name: '严重' }));
    await waitFor(() => expect(screen.queryByText('中危项回答XYZ')).not.toBeInTheDocument());
    expect(screen.getByText('严重项回答ABC')).toBeInTheDocument();

    // 下载携带所选等级
    await userEvent.click(screen.getByRole('button', { name: /生成并下载 PDF/ }));
    await waitFor(() =>
      expect(api.reports.download).toHaveBeenCalledWith(
        'report-risk',
        { severity: ['CRITICAL'], riskDomain: [] },
        'pdf',
      ),
    );
  });

  it('详情可勾选导出章节，下载按所选章节导出', async () => {
    apiMock.get.mockResolvedValue(riskItemsReport);
    renderPage('/reports?reportId=report-risk');
    await waitFor(() => expect(api.reports.get).toHaveBeenCalledWith('report-risk'));

    // 取消「多轮攻击测试实录（红队）」章节
    await userEvent.click(await screen.findByRole('button', { name: '多轮攻击测试实录（红队）' }));
    await userEvent.click(screen.getByRole('button', { name: /生成并下载 PDF/ }));
    await waitFor(() => expect(api.reports.download).toHaveBeenCalled());
    const lastCall = apiMock.download.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe('report-risk');
    expect(lastCall[1].sections).not.toContain('redTeam');
    expect(lastCall[1].sections).toContain('riskItems');
    expect(lastCall[1].sections).toContain('gbtCompliance');
    expect(lastCall[1].sections).toContain('resultOverview');
    expect(lastCall[1].sections).toHaveLength(6);
    expect(lastCall[1].profile).toBe('full');
    expect(lastCall[2]).toBe('pdf');
  });

  it('详情可选下载 HTML，沿用所选模板和筛选', async () => {
    apiMock.get.mockResolvedValue(riskItemsReport);
    renderPage('/reports?reportId=report-risk');
    await waitFor(() => expect(api.reports.get).toHaveBeenCalledWith('report-risk'));
    await userEvent.click(await screen.findByRole('button', { name: '严重' }));
    await userEvent.click(screen.getByRole('button', { name: '下载 HTML' }));
    await waitFor(() =>
      expect(api.reports.download).toHaveBeenCalledWith(
        'report-risk',
        { severity: ['CRITICAL'], riskDomain: [] },
        'html',
      ),
    );
  });

  it('详情选了报告模板，下载请求带 templateId', async () => {
    apiMock.templates.mockResolvedValue({
      items: [{ id: 'tpl-1', name: '客户交付模板', isDefault: false, sections: [] }],
    });
    apiMock.get.mockResolvedValue(riskItemsReport);
    renderPage('/reports?reportId=report-risk');
    await waitFor(() => expect(api.reports.get).toHaveBeenCalledWith('report-risk'));
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: '报告模板' }),
      '客户交付模板',
    );
    await userEvent.click(screen.getByRole('button', { name: '下载 HTML' }));
    await waitFor(() =>
      expect(api.reports.download).toHaveBeenCalledWith(
        'report-risk',
        { severity: [], riskDomain: [], templateId: 'tpl-1' },
        'html',
      ),
    );
  });

  it('综合检测报告在列表里标「综合检测 · N 项」', async () => {
    apiMock.list.mockResolvedValue({
      items: [
        {
          ...report,
          id: 'report-detect',
          taskId: null,
          kind: 'combined',
          title: '季度检测 综合检测报告',
          taskCount: 1,
          detectItemCount: 3,
          label: '综合检测 · 3 项',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    renderPage();
    expect(await screen.findByText('综合检测 · 3 项')).toBeInTheDocument();
  });

  it('按交付模板、风险等级和风险领域配置导出，不暴露内部工程筛选', async () => {
    apiMock.get.mockResolvedValue(riskItemsReport);
    renderPage('/reports?reportId=report-risk');
    await waitFor(() => expect(api.reports.get).toHaveBeenCalledWith('report-risk'));

    expect(await screen.findByRole('button', { name: /完整综合报告/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /领导简报/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /整改任务书/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /合规证据包/ })).toBeInTheDocument();
    expect(screen.queryByText(/引擎 ID|任务 ID|数据库 ID/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /整改任务书/ }));
    await userEvent.click(screen.getByRole('button', { name: '高危' }));
    await userEvent.click(screen.getByRole('button', { name: /内容合规/ }));
    await userEvent.click(screen.getByRole('button', { name: /生成并下载 PDF/ }));

    await waitFor(() =>
      expect(api.reports.download).toHaveBeenCalledWith(
        'report-risk',
        {
          profile: 'remediation_work_order',
          severity: ['HIGH'],
          riskDomain: ['legal_compliance'],
          sections: ['riskItems', 'remediation', 'nextSteps'],
        },
        'pdf',
      ),
    );
  });

it('国标报告：列表显示中文类型、整体结论与等级，详情用 sandbox iframe 显示 HTML，PDF 走报告下载', async () => {
    const gbt = {
      id: 'report-gbt',
      taskId: '11111111-1111-4111-8111-111111111111',
      title: '生成内容安全评估报告（GB/T 45654） - 国标任务',
      format: 'html',
      kind: 'gbt45654_content',
      content: '<html><body><h1>生成内容安全评估报告（GB/T 45654）</h1></body></html>',
      summary: {
        kind: 'gbt45654_content',
        headline: '部分条款发现风险（预评估）',
        metrics: { overallLabel: '部分条款发现风险', gradeLabel: '预评估', validCount: 183 },
        totalQuestions: 183,
        processedQuestions: 0,
        passedCount: 0,
        failedCount: 0,
        errorCount: 0,
        wrongAnswerCount: 0,
        findingCount: 0,
        verdictDistribution: {},
        severityDistribution: {},
      },
      passRate: null,
      totalQuestions: 183,
      riskDistribution: null,
      generatedById: null,
      createdAt: '2026-06-01T08:00:00.000Z',
    };
    apiMock.list.mockResolvedValue({ items: [gbt], total: 1, page: 1, pageSize: 10 });
    apiMock.get.mockResolvedValue(gbt);
    renderPage('/reports');

    expect(await screen.findByText('部分条款发现风险')).toBeInTheDocument();
    expect(screen.getByText('预评估')).toBeInTheDocument();
    expect(
      screen.getAllByText('生成内容安全评估报告（GB/T 45654）').filter((el) => el.tagName === 'SPAN').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/缺少统一评估结论快照/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '查看' }));
    const frame = await screen.findByTitle('国标评估报告');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('<h1>生成内容安全评估报告（GB/T 45654）</h1>');
    expect(screen.queryByText('选择交付模板')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '生成并下载 PDF' }));
    await waitFor(() => expect(api.reports.download).toHaveBeenCalledWith('report-gbt', {}, 'pdf'));
  });

  it('列表导出入口先打开配置，不绕过模板直接下载', async () => {
    renderPage();
    await screen.findByText('指令篡改抵抗专项 - 任务 A');
    await userEvent.click(screen.getByRole('button', { name: '导出' }));

    await waitFor(() => expect(api.reports.get).toHaveBeenCalledWith('report-1'));
    expect(api.reports.download).not.toHaveBeenCalled();
    expect(await screen.findByText('选择交付模板')).toBeInTheDocument();
  });

  it('无 report:download 权限时隐藏下载按钮', async () => {
    authMock.hasPermission.mockImplementation((code: string) => code !== 'report:download');

    renderPage();

    await screen.findByText('指令篡改抵抗专项 - 任务 A');
    expect(screen.queryByRole('button', { name: /下载报告（PDF）/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /审计底稿/ })).not.toBeInTheDocument();
  });
});
