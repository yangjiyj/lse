import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentScanRedirect } from '@/App';
import { ToastProvider } from '@/components/ui/toast';
import { ServiceAssurancePage } from './ServiceAssurancePage';

const apiMock = vi.hoisted(() => ({
  listTasks: vi.fn(),
  readiness: vi.fn(),
  scopePolicies: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  createRun: vi.fn(),
  cancelRun: vi.fn(),
  reviewAssessment: vi.fn(),
  retestAssessment: vi.fn(),
  evidence: vi.fn(),
  createReport: vi.fn(),
  linkTask: vi.fn(),
  unlinkTask: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  permissions: new Set<string>(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    evalTasks: { list: apiMock.listTasks },
    serviceAssurance: {
      readiness: apiMock.readiness,
      scopePolicies: apiMock.scopePolicies,
      listRuns: apiMock.listRuns,
      getRun: apiMock.getRun,
      createRun: apiMock.createRun,
      cancelRun: apiMock.cancelRun,
      reviewAssessment: apiMock.reviewAssessment,
      retestAssessment: apiMock.retestAssessment,
      evidence: apiMock.evidence,
      linkTask: apiMock.linkTask,
      unlinkTask: apiMock.unlinkTask,
    },
    reports: { create: apiMock.createReport },
  },
}));

vi.mock('@/lib/auth', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    user: { username: 'operator' },
    loading: false,
    hasPermission: (code: string) => authMock.permissions.has(code),
  }),
}));

const task = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '生产模型接口核验',
  description: null,
  status: 'COMPLETED',
  modelTarget: null,
  engines: [],
  dimensions: [],
  concurrency: 1,
  totalQuestions: 0,
  processedQuestions: 0,
  passedCount: 0,
  failedCount: 0,
  errorCount: 0,
  progress: 1,
  questionSetCount: 0,
  resultCount: 0,
  logCount: 0,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-08-30T01:00:00.000Z',
  updatedAt: '2026-08-30T01:00:00.000Z',
};

const run = {
  runId: '22222222-2222-4222-8222-222222222222',
  taskId: task.id as string | null,
  taskName: task.name as string | null,
  mode: 'SAFE' as const,
  targetKind: 'ENDPOINT' as const,
  targetName: '生产推理接口',
  status: 'PARTIAL' as const,
  coverageStatus: 'INCOMPLETE' as const,
  statusMessage: '核验未完成或覆盖不完整。',
  summary: {
    confirmed: 1,
    underInvestigation: 1,
    notAffected: 1,
    fixed: 1,
    incomplete: true,
    statusMessage: '核验未完成或覆盖不完整。',
  },
  createdAt: '2026-08-30T02:00:00.000Z',
  completedAt: '2026-08-30T02:02:00.000Z',
};

const detail = {
  run,
  assets: [
    {
      assetId: '33333333-3333-4333-8333-333333333333',
      name: '生产推理接口',
      address: 'https://model.example.test/v1',
      protocol: 'https',
      host: 'model.example.test',
      port: 443,
      title: '模型服务',
    },
  ],
  components: [
    {
      componentId: '44444444-4444-4444-8444-444444444444',
      name: 'Envoy Proxy',
      vendor: 'Envoy Project',
      version: '1.29.2',
      confidence: 0.98,
      evidenceLabel: '版本证据',
    },
    {
      componentId: '55555555-5555-4555-8555-555555555555',
      name: 'NVIDIA Triton Inference Server',
      vendor: 'NVIDIA',
      version: null,
      confidence: 0.42,
      evidenceLabel: '待核验线索',
    },
  ],
  results: [
    {
      assessmentId: '66666666-6666-4666-8666-666666666666',
      title: '公开管理接口缺少访问控制',
      advisoryId: null,
      severity: 'HIGH' as const,
      impactStatus: 'AFFECTED' as const,
      confidence: 0.96,
      priority: 'P0' as const,
      reason: '配置证据确认管理接口在未提供身份凭据时仍可访问。',
      remediation: '关闭公网管理入口，并启用身份认证与最小权限控制。',
      evidenceLabel: '配置证据',
    },
    {
      assessmentId: '77777777-7777-4777-8777-777777777777',
      title: '组件身份仍需确认',
      advisoryId: null,
      severity: null,
      impactStatus: 'UNDER_INVESTIGATION' as const,
      confidence: 0.42,
      priority: 'UNKNOWN' as const,
      reason: '仅取得组件名称线索，尚未取得版本或授权验证证据。',
      remediation: null,
      evidenceLabel: '待核验线索',
    },
  ],
};

function renderPage(initialEntry = '/service-assurance') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ToastProvider>
          <ServiceAssurancePage />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ServiceAssurancePage', () => {
  it('地址带 ?run= 时直接选中这次核验', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    apiMock.listRuns.mockResolvedValue({ items: [run, { ...run, runId: other }] });
    renderPage(`/service-assurance?run=${other}`);
    await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledWith(other));
    expect(apiMock.getRun).not.toHaveBeenCalledWith(run.runId);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.permissions = new Set([
      'service_assurance:read',
      'service_assurance:scan',
      'service_assurance:verify',
      'service_assurance:review',
      'report:generate',
    ]);
    apiMock.listTasks.mockResolvedValue({ items: [task], total: 1, page: 1, pageSize: 100 });
    apiMock.readiness.mockResolvedValue({
      modes: [
        {
          mode: 'SAFE',
          ready: true,
          message: '安全检查已就绪。',
          baselineUpdatedAt: '2026-08-29T00:00:00.000Z',
        },
        {
          mode: 'DEEP',
          ready: false,
          message: '授权深度核验尚未就绪。',
          baselineUpdatedAt: null,
        },
        {
          mode: 'SBOM',
          ready: true,
          message: '组件清单核验已就绪。',
          baselineUpdatedAt: '2026-08-29T00:00:00.000Z',
        },
      ],
    });
    apiMock.scopePolicies.mockResolvedValue({
      policies: [
        {
          ref: 'customer-api',
          name: '客户 API',
          origins: ['https://customer.example.test'],
          cidrs: ['93.184.216.34/32'],
          allowPrivate: false,
          allowPublic: true,
          isDefault: true,
        },
      ],
      defaultPolicyRef: 'customer-api',
      managedByPlatform: true,
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    apiMock.listRuns.mockResolvedValue({ items: [run] });
    apiMock.getRun.mockResolvedValue(detail);
    apiMock.createRun.mockResolvedValue({ run: { ...run, status: 'PENDING' } });
    apiMock.cancelRun.mockResolvedValue({ run: { ...run, status: 'CANCELED' } });
    apiMock.reviewAssessment.mockResolvedValue({
      result: {
        impactStatus: 'NOT_AFFECTED',
        reason: '目标中不存在该组件：已核对部署清单。',
        reviewedAt: '2026-08-30T03:00:00.000Z',
      },
    });
    apiMock.retestAssessment.mockResolvedValue({
      run: { ...run, status: 'PENDING', coverageStatus: 'NOT_READY' },
    });
    apiMock.evidence.mockResolvedValue({
      items: [
        {
          evidenceId: '88888888-8888-4888-8888-888888888888',
          assessmentId: detail.results[0]!.assessmentId,
          evidenceType: 'http-response',
          ruleId: 'missing-access-control',
          ruleSummary: '未授权访问检查',
          matchedLocation: 'HTTP 状态',
          customerSummary: '未提供身份凭据时接口仍返回成功响应。',
          requestSummary: 'GET /admin',
          responseSummary: 'HTTP 200',
          contentSha256: 'a'.repeat(64),
          visibility: 'TECHNICAL',
        },
      ],
    });
    apiMock.createReport.mockResolvedValue({ id: 'report-service-assurance' });
  });

  it('无需先选择任务：顶部说明、发起表单与核验记录同时可见，概要突出风险', async () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { name: 'AI 服务安全核验' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '核验说明' })).toHaveTextContent(
      '无需预先创建评估任务',
    );
    expect(await screen.findByText('公开管理接口缺少访问控制')).toBeInTheDocument();
    expect(screen.queryByLabelText('查看归属任务')).not.toBeInTheDocument();
    expect(screen.getByLabelText('目标地址')).toBeInTheDocument();
    expect(screen.getByLabelText('归属评估任务（可选）')).toHaveValue('');
    expect(screen.getByRole('button', { name: '基础检查' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '组件清单核验' })).toBeInTheDocument();
    expect(screen.getByTestId('assurance-run-task')).toHaveTextContent(`已关联：${task.name}`);
    const summary = screen.getByTestId('assurance-summary');
    for (const label of ['已确认风险', '待补充证据', '不受影响', '已修复']) {
      expect(within(summary).getByText(label)).toBeInTheDocument();
    }
    expect(within(summary).queryByText('核验未完成')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(
      /AI-Infra-Guard|\\bAIG\\b|Nuclei|Trivy|\\bZAP\\b|rawOutput|session ID/,
    );
  });

  it('模式未就绪时显示真实限制并禁止发起', async () => {
    renderPage();
    await screen.findByText('公开管理接口缺少访问控制');

    await userEvent.click(screen.getByRole('button', { name: '基础及附加授权检查' }));

    expect(screen.getByText('授权深度核验尚未就绪。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发起核验' })).toBeDisabled();
  });

  it('未配置授权范围时在表单内阻止远程核验并引导管理员设置', async () => {
    authMock.permissions.add('platform_setting:update');
    apiMock.scopePolicies.mockResolvedValue({
      policies: [],
      defaultPolicyRef: null,
      managedByPlatform: true,
      updatedAt: null,
    });
    renderPage();
    await screen.findByText('公开管理接口缺少访问控制');
    await userEvent.type(screen.getByLabelText('目标地址'), 'https://customer.example.test/v1');

    expect(screen.getByText(/尚未配置远程目标授权范围/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发起核验' })).toBeDisabled();
    expect(screen.getByRole('link', { name: '前往平台设置配置授权范围 →' })).toHaveAttribute(
      'href',
      '/settings#service-assurance-scope',
    );
    expect(apiMock.createRun).not.toHaveBeenCalled();
  });

  it('只提交客户字段和平台范围引用，不提交命令、模板、并发或超时', async () => {
    renderPage();
    await screen.findByText('公开管理接口缺少访问控制');

    await userEvent.clear(screen.getByLabelText('目标名称'));
    await userEvent.type(screen.getByLabelText('目标名称'), '客户模型服务');
    await userEvent.type(screen.getByLabelText('目标地址'), 'https://customer.example.test/v1');
    await userEvent.click(screen.getByRole('button', { name: '发起核验' }));

    await waitFor(() =>
      expect(apiMock.createRun).toHaveBeenCalledWith({
        mode: 'SAFE',
        targetKind: 'ENDPOINT',
        targetName: '客户模型服务',
        targetUrl: 'https://customer.example.test/v1',
        scopePolicyRef: 'customer-api',
        authorizationConfirmed: false,
      }),
    );
    const submitted = apiMock.createRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(submitted).not.toHaveProperty('templatePath');
    expect(submitted).not.toHaveProperty('command');
    expect(submitted).not.toHaveProperty('concurrency');
    expect(submitted).not.toHaveProperty('timeout');
    expect(submitted).not.toHaveProperty('apiKey');
  });

  it('首次组件清单核验必须上传受限文件并只提交清单内容', async () => {
    renderPage();
    await screen.findByText('公开管理接口缺少访问控制');

    await userEvent.click(screen.getByRole('button', { name: '组件清单核验' }));
    expect(screen.getByRole('button', { name: '发起核验' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '选择组件清单' })).toBeVisible();
    expect(screen.getByText('尚未选择文件。')).toBeVisible();

    const file = new File(
      ['{"bomFormat":"CycloneDX","specVersion":"1.5","components":[]}'],
      'customer-sbom.json',
      { type: 'application/json' },
    );
    await userEvent.upload(screen.getByLabelText('组件清单文件'), file);
    expect(screen.getByText('已选择：customer-sbom.json')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '发起核验' }));

    await waitFor(() =>
      expect(apiMock.createRun).toHaveBeenCalledWith({
        mode: 'SBOM',
        targetKind: 'SBOM',
        targetName: 'customer-sbom.json',
        scopePolicyRef: 'not-applicable',
        authorizationConfirmed: false,
        sbom: {
          contentType: 'application/json',
          content: '{"bomFormat":"CycloneDX","specVersion":"1.5","components":[]}',
        },
      }),
    );
    const submitted = apiMock.createRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(submitted).not.toHaveProperty('targetUrl');
    expect(submitted).not.toHaveProperty('credentialRef');
    expect(submitted).not.toHaveProperty('templatePath');
    expect(submitted).not.toHaveProperty('command');
    expect(submitted).not.toHaveProperty('concurrency');
    expect(submitted).not.toHaveProperty('timeout');
  });

  it('没有复核权限时不展示也不请求技术证据', async () => {
    authMock.permissions.delete('service_assurance:review');
    renderPage();

    await screen.findByText('公开管理接口缺少访问控制');
    expect(screen.queryByRole('button', { name: '查看技术证据' })).not.toBeInTheDocument();
    expect(apiMock.evidence).not.toHaveBeenCalled();
  });

  it('有复核权限时按需加载脱敏技术证据', async () => {
    renderPage();
    await screen.findByText('公开管理接口缺少访问控制');

    await userEvent.click(screen.getByRole('button', { name: '查看技术证据' }));

    expect(await screen.findByText('未授权访问检查')).toBeInTheDocument();
    expect(apiMock.evidence).toHaveBeenCalledWith(run.runId);
    expect(screen.getByText('GET /admin')).toBeInTheDocument();
    expect(screen.getByText('HTTP 200')).toBeInTheDocument();
  });

  it('人工复核只提交受控理由和客户说明', async () => {
    const { container } = renderPage();
    const title = await screen.findByText('公开管理接口缺少访问控制');
    const card = title.closest('article');
    expect(card).not.toBeNull();

    await userEvent.click(within(card!).getByRole('button', { name: '复核结论' }));
    // 弹窗标题也叫「复核结论」（Modal 现在用标题命名对话框），所以按角色精确取下拉框。
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: '复核结论' }),
      'NOT_AFFECTED',
    );
    await userEvent.selectOptions(screen.getByLabelText('不受影响依据'), 'component_not_present');
    await userEvent.type(screen.getByLabelText('复核说明'), '已核对部署清单，目标中不存在该组件。');
    await userEvent.click(screen.getByRole('button', { name: '保存复核' }));

    await waitFor(() =>
      expect(apiMock.reviewAssessment).toHaveBeenCalledWith(detail.results[0]!.assessmentId, {
        impactStatus: 'NOT_AFFECTED',
        justification: 'component_not_present',
        statement: '已核对部署清单，目标中不存在该组件。',
      }),
    );
    expect(container.textContent).not.toMatch(/component_not_present|retestRunId|assessmentId/i);
  });

  it('普通复测只提交空请求并由服务端复制原运行范围', async () => {
    renderPage();
    const title = await screen.findByText('公开管理接口缺少访问控制');
    const card = title.closest('article');
    expect(card).not.toBeNull();

    await userEvent.click(within(card!).getByRole('button', { name: '发起复测' }));
    await userEvent.click(screen.getByRole('button', { name: '开始复测' }));

    await waitFor(() =>
      expect(apiMock.retestAssessment).toHaveBeenCalledWith(detail.results[0]!.assessmentId, {}),
    );
  });

  it('组件清单复测只提交新的受限文件内容', async () => {
    const sbomRun = { ...run, mode: 'SBOM' as const, targetKind: 'SBOM' as const };
    apiMock.listRuns.mockResolvedValue({ items: [sbomRun] });
    apiMock.getRun.mockResolvedValue({ ...detail, run: sbomRun });
    renderPage();
    const title = await screen.findByText('公开管理接口缺少访问控制');
    const card = title.closest('article');
    expect(card).not.toBeNull();

    await userEvent.click(within(card!).getByRole('button', { name: '发起复测' }));
    const file = new File(
      ['{"bomFormat":"CycloneDX","specVersion":"1.5","components":[]}'],
      'sbom.json',
      {
        type: 'application/json',
      },
    );
    await userEvent.upload(screen.getByLabelText('新的组件清单'), file);
    await userEvent.click(screen.getByRole('button', { name: '开始复测' }));

    await waitFor(() =>
      expect(apiMock.retestAssessment).toHaveBeenCalledWith(detail.results[0]!.assessmentId, {
        sbom: {
          contentType: 'application/json',
          content: '{"bomFormat":"CycloneDX","specVersion":"1.5","components":[]}',
        },
      }),
    );
  });

  it('无扫描或深度核验权限时不展示复测动作', async () => {
    authMock.permissions.delete('service_assurance:scan');
    authMock.permissions.delete('service_assurance:verify');
    renderPage();
    await screen.findByText('公开管理接口缺少访问控制');
    expect(screen.queryByRole('button', { name: '发起复测' })).not.toBeInTheDocument();
  });

  it('任务完成且已有核验运行时可从工作台生成正式报告', async () => {
    renderPage();
    await screen.findByText('公开管理接口缺少访问控制');

    await userEvent.click(screen.getByRole('button', { name: '生成归属任务汇总报告' }));

    await waitFor(() =>
      expect(apiMock.createReport).toHaveBeenCalledWith({
        taskId: task.id,
        kind: 'service_assurance',
        explanationMode: 'local',
      }),
    );
  });

  it('没有报告生成权限时不显示生成入口', async () => {
    authMock.permissions.delete('report:generate');
    renderPage();
    await screen.findByText('公开管理接口缺少访问控制');
    expect(screen.queryByRole('button', { name: '生成归属任务汇总报告' })).not.toBeInTheDocument();
  });
  it.each([false, true])('列表延迟更新时保持选中新建运行（跨任务：%s）', async (differentTask) => {
    const otherTask = { ...task, id: 'task-other', name: '另一归属任务' };
    const destinationTask = differentTask ? otherTask : task;
    const newRun = {
      ...run,
      runId: '99999999-9999-4999-8999-999999999999',
      taskId: destinationTask.id,
      targetName: '刚创建的核验',
      status: 'COMPLETED',
    };
    let finishList: ((value: { items: (typeof run)[] }) => void) | undefined;
    const delayedList = new Promise<{ items: (typeof run)[] }>((resolve) => {
      finishList = resolve;
    });
    apiMock.listTasks.mockResolvedValue({ items: [task, otherTask], total: 2 });
    apiMock.listRuns.mockResolvedValueOnce({ items: [run] }).mockImplementation(() => delayedList);
    apiMock.createRun.mockResolvedValue({ run: newRun });
    apiMock.getRun.mockImplementation((runId: string) =>
      Promise.resolve({ ...detail, run: runId === newRun.runId ? newRun : run }),
    );
    renderPage();
    await screen.findByText('公开管理接口缺少访问控制');
    if (differentTask)
      await userEvent.selectOptions(
        screen.getByLabelText('归属评估任务（可选）'),
        destinationTask.id,
      );
    await userEvent.type(screen.getByLabelText('目标地址'), 'https://customer.example.test/v1');
    await userEvent.click(screen.getByRole('button', { name: '发起核验' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /刚创建的核验/ })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    );
    expect(screen.getByLabelText('按评估任务筛选')).toHaveValue('');
    expect(apiMock.getRun).toHaveBeenCalledWith(newRun.runId);
    await act(async () => {
      finishList?.({ items: differentTask ? [newRun as typeof run] : [newRun as typeof run, run] });
      await delayedList;
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /刚创建的核验/ })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    );
    expect(screen.getByRole('region', { name: '本次执行与覆盖' })).toHaveTextContent(
      '刚创建的核验',
    );
  });

  it('复测返回新运行时，旧列表不能抢回选中状态', async () => {
    const newRun = {
      ...run,
      runId: '99999999-9999-4999-8999-999999999998',
      targetName: '刚创建的复测',
      status: 'COMPLETED',
    };
    let finishList: ((value: { items: (typeof run)[] }) => void) | undefined;
    const delayedList = new Promise<{ items: (typeof run)[] }>((resolve) => {
      finishList = resolve;
    });
    apiMock.listRuns.mockResolvedValueOnce({ items: [run] }).mockImplementation(() => delayedList);
    apiMock.retestAssessment.mockResolvedValue({ run: newRun });
    apiMock.getRun.mockImplementation((runId: string) =>
      Promise.resolve({ ...detail, run: runId === newRun.runId ? newRun : run }),
    );
    renderPage();
    const title = await screen.findByText('公开管理接口缺少访问控制');
    await userEvent.click(
      within(title.closest('article')!).getByRole('button', { name: '发起复测' }),
    );
    await userEvent.click(screen.getByRole('button', { name: '开始复测' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /刚创建的复测/ })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    );
    await act(async () => {
      finishList?.({ items: [newRun as typeof run, run] });
      await delayedList;
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /刚创建的复测/ })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    );
    expect(screen.getByRole('region', { name: '本次执行与覆盖' })).toHaveTextContent(
      '刚创建的复测',
    );
  });

  it('发起表单选择归属任务不会改变记录列表筛选；列表默认列出全部可见记录', async () => {
    const otherTask = { ...task, id: 'task-other', name: '另一归属任务' };
    apiMock.listTasks.mockResolvedValue({ items: [task, otherTask], total: 2 });
    renderPage();
    await screen.findByText('公开管理接口缺少访问控制');
    expect(apiMock.listRuns).toHaveBeenCalledWith({ pageSize: 50 });
    await userEvent.selectOptions(screen.getByLabelText('归属评估任务（可选）'), otherTask.id);
    expect(screen.getByLabelText('按评估任务筛选')).toHaveValue('');
    expect(apiMock.listRuns).not.toHaveBeenCalledWith({ taskId: otherTask.id });
  });

  it('旧链接 ?taskId= 仍按该任务筛选记录', async () => {
    renderPage(`/service-assurance?taskId=${task.id}`);
    await screen.findByText('公开管理接口缺少访问控制');
    expect(apiMock.listRuns).toHaveBeenCalledWith({ taskId: task.id });
    expect(screen.getByLabelText('按评估任务筛选')).toHaveValue(task.id);
  });

  it('没有评估任务时仍可发起核验，记录显示“未关联”并可在详情中关联', async () => {
    const standalone = { ...run, taskId: null, taskName: null, status: 'COMPLETED' as const };
    apiMock.listTasks.mockResolvedValue({ items: [], total: 0 });
    apiMock.listRuns.mockResolvedValue({ items: [standalone] });
    apiMock.getRun.mockResolvedValue({ ...detail, run: standalone });
    renderPage();
    await screen.findByText('公开管理接口缺少访问控制');
    expect(screen.queryByText('暂无可归属的评估任务')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发起核验' })).toBeInTheDocument();
    expect(screen.getByTestId('assurance-run-task')).toHaveTextContent('未关联');
    expect(screen.getByText('未关联评估任务')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成归属任务汇总报告' })).not.toBeInTheDocument();
  });

  it('在详情中关联评估任务与取消关联', async () => {
    const standalone = { ...run, taskId: null, taskName: null, status: 'COMPLETED' as const };
    const linked = { ...standalone, taskId: task.id, taskName: task.name };
    apiMock.listRuns.mockResolvedValue({ items: [standalone] });
    apiMock.getRun.mockResolvedValue({ ...detail, run: standalone });
    apiMock.linkTask.mockImplementation(async () => {
      apiMock.listRuns.mockResolvedValue({ items: [linked] });
      apiMock.getRun.mockResolvedValue({ ...detail, run: linked });
      return { run: linked, findingCount: 1 };
    });
    apiMock.unlinkTask.mockResolvedValue({ run: standalone });
    renderPage();
    await screen.findByText('未关联评估任务');
    const linkButton = screen.getByRole('button', { name: '关联评估任务' });
    expect(linkButton).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('关联评估任务'), task.id);
    await userEvent.click(linkButton);
    await waitFor(() => expect(apiMock.linkTask).toHaveBeenCalledWith(run.runId, task.id));

    expect(await screen.findByText(`已关联评估任务：${task.name}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '取消关联' }));
    await waitFor(() => expect(apiMock.unlinkTask).toHaveBeenCalledWith(run.runId));
  });

  it('零命中仍展示执行与覆盖并允许查看证据，未知请求数不能写成零', async () => {
    const completed = {
      ...run,
      status: 'COMPLETED',
      targetAddress: 'https://model.example.test/v1',
    };
    apiMock.listRuns.mockResolvedValue({ items: [completed] });
    apiMock.getRun.mockResolvedValue({
      ...detail,
      run: completed,
      results: [],
      execution: {
        telemetryAvailable: true,
        requestCount: null,
        checks: [
          {
            id: 'header',
            label: '响应头检查',
            status: 'COMPLETED',
            requestCount: 1,
            detail: '已检查响应。',
          },
          {
            id: 'component',
            label: '组件版本核对',
            status: 'SKIPPED',
            requestCount: null,
            detail: '未取得版本证据。',
          },
        ],
        limitations: ['未覆盖身份验证后的接口。'],
      },
    });
    renderPage();
    expect(await screen.findByText('执行完成，部分范围无法判断')).toBeInTheDocument();
    await screen.findByText('响应头检查');
    const coverage = screen.getByRole('region', { name: '本次执行与覆盖' });
    expect(coverage).toHaveTextContent('完成 1，失败 0，跳过 1，无法确认 0');
    expect(coverage).toHaveTextContent('请求数量：未采集');
    expect(coverage).toHaveTextContent('未取得版本证据。');
    expect(screen.getByText(/零条风险记录不等于已经证明安全/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看技术证据' }));
    expect(apiMock.evidence).toHaveBeenCalledWith(run.runId);
  });

  it('旧记录缺少执行数据时明确说明无法确认覆盖', async () => {
    renderPage();
    expect(await screen.findByText(/该记录未采集完整执行数据/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '本次执行与覆盖' })).not.toHaveTextContent(
      '请求数量：0',
    );
  });

  it('MCP 历史结果可读，但不提供新建复测入口', async () => {
    const legacyRun = { ...run, targetKind: 'MCP' };
    apiMock.listRuns.mockResolvedValue({ items: [legacyRun] });
    apiMock.getRun.mockResolvedValue({ ...detail, run: legacyRun });
    renderPage();
    expect(await screen.findByText('公开管理接口缺少访问控制')).toBeInTheDocument();
    expect(screen.getByText('MCP（历史记录）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发起复测' })).not.toBeInTheDocument();
  });

  it('归属任务未完成时解释报告按钮不可用', async () => {
    apiMock.listTasks.mockResolvedValue({ items: [{ ...task, status: 'RUNNING' }], total: 1 });
    renderPage();
    expect(await screen.findByRole('button', { name: '生成归属任务汇总报告' })).toBeDisabled();
    expect(screen.getByText(/归属评估任务完成后才能生成汇总报告/)).toBeInTheDocument();
  });

  it('执行中自动更新详情，终态停止轮询', async () => {
    const pending = { ...run, status: 'RUNNING' };
    const completed = { ...run, status: 'COMPLETED', coverageStatus: 'COMPLETE' };
    apiMock.listRuns
      .mockResolvedValueOnce({ items: [pending] })
      .mockResolvedValue({ items: [completed] });
    apiMock.getRun
      .mockResolvedValueOnce({ ...detail, run: pending })
      .mockResolvedValue({ ...detail, run: completed });
    renderPage();
    await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(await screen.findByText('核验已完成')).toBeInTheDocument();
    const reads = apiMock.getRun.mock.calls.length;
    const lists = apiMock.listRuns.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2800));
    expect(apiMock.getRun).toHaveBeenCalledTimes(reads);
    expect(apiMock.listRuns).toHaveBeenCalledTimes(lists);
  }, 10000);
});

function LocationProbe() {
  return <span>{useLocation().pathname}</span>;
}

describe('旧路由兼容', () => {
  it('把旧组件扫描书签替换到服务安全核验', async () => {
    render(
      <MemoryRouter initialEntries={['/component-scan']}>
        <Routes>
          <Route path="/component-scan" element={<ComponentScanRedirect />} />
          <Route path="/service-assurance" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('/service-assurance')).toBeInTheDocument();
  });
});
