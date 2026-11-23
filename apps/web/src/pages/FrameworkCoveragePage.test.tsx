import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { FrameworkCoveragePage, FrameworkMapRedirect } from './FrameworkCoveragePage';

const apiMock = vi.hoisted(() => ({ coverage: vi.fn(), targets: vi.fn(), heatmap: vi.fn() }));
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      frameworks: { coverage: apiMock.coverage, heatmap: apiMock.heatmap },
      modelTargets: { list: apiMock.targets },
    },
  };
});

type Status = 'NOT_TESTED' | 'TESTED_CLEAN' | 'TESTED_FINDINGS' | 'NOT_SUPPORTED';
const row = (
  framework: string,
  entryId: string,
  entryName: string,
  entryNameEn: string,
  status: Status,
  tested = 0,
  failed = 0,
  extra = {},
) => ({
  framework,
  entryId,
  entryName,
  entryNameEn,
  tested,
  passed: tested - failed,
  failed,
  undetermined: 0,
  status,
  sampleAdequate: tested >= 10,
  riskDomains: [],
  recentTasks: [],
  ...extra,
});

const heatmapPayload = {
  framework: 'ATLAS_MATRIX',
  columns: [{ id: 'g1', label: '目标甲' }],
  items: [
    {
      id: 'AML.TA.R',
      nameEn: 'Search Open Technical Databases',
      nameZh: '搜索公开技术数据库',
      groupZh: '侦察',
    },
    {
      id: 'AML.T0051',
      nameEn: 'LLM Prompt Injection',
      nameZh: '大模型提示词注入',
      groupZh: '执行',
    },
    { id: 'AML.T0109', nameEn: 'AI Supply Chain Rug Pull', nameZh: '', groupZh: '影响' },
  ],
  cells: [
    {
      entryId: 'AML.TA.R',
      columnId: 'g1',
      tested: false,
      testCount: 0,
      failCount: 0,
      rate: null,
      coverage: 0,
      findingIds: [],
    },
    {
      entryId: 'AML.T0051',
      columnId: 'g1',
      tested: true,
      testCount: 5,
      failCount: 2,
      rate: 0.4,
      coverage: 0.5,
      findingIds: ['f1'],
    },
    {
      entryId: 'AML.T0109',
      columnId: 'g1',
      tested: false,
      testCount: 0,
      failCount: 0,
      rate: null,
      coverage: 0,
      findingIds: [],
    },
  ],
  unmappedCount: 123,
  unmapped: [
    { label: '内容安全风险', count: 100 },
    { label: '一般安全风险', count: 23 },
  ],
  disclaimer: '参考映射',
};

const payload = {
  scope: { taskId: null, targetId: null, days: null },
  rows: [
    row('OWASP_AGENTIC', 'ASI01', '智能体目标劫持', 'Agent Goal Hijack', 'TESTED_FINDINGS', 12, 2, {
      riskDomains: [{ domain: 'prompt_injection', label: '提示词注入/越狱风险', tested: 12 }],
      recentTasks: [{ id: 't1', name: '示例任务一' }],
    }),
    row(
      'OWASP_AGENTIC',
      'ASI02',
      '工具滥用与利用',
      'Tool Misuse & Exploitation',
      'TESTED_CLEAN',
      4,
    ),
    row('OWASP_AGENTIC', 'ASI03', '身份与权限滥用', 'Identity & Privilege Abuse', 'NOT_TESTED'),
    row(
      'OWASP_AGENTIC',
      'ASI04',
      '智能体供应链漏洞',
      'Agentic Supply Chain Vulnerabilities',
      'NOT_SUPPORTED',
      0,
      0,
      { note: '平台暂不覆盖：示例原因' },
    ),
    row('OWASP_LLM', 'LLM01', '提示词注入', 'Prompt Injection', 'TESTED_CLEAN', 20),
    row('GBT45654_ANNEX_A', 'A.1', '违反社会主义核心价值观的内容', '', 'NOT_TESTED'),
    row('ATLAS', 'AML.T0051', '大模型提示词注入', 'LLM Prompt Injection', 'NOT_TESTED'),
  ],
  summary: {
    entries: 7,
    byStatus: { NOT_TESTED: 3, TESTED_CLEAN: 2, TESTED_FINDINGS: 1, NOT_SUPPORTED: 1 },
    totalTested: 38,
    unmappedTested: 3,
  },
  disclaimer: '未测试不等于安全',
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function renderPage(url = '/reports/framework-coverage') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/reports/framework-coverage" element={<FrameworkCoveragePage />} />
          <Route
            path="/risk/framework-map"
            element={
              <>
                <FrameworkMapRedirect />
              </>
            }
          />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('FrameworkCoveragePage', () => {
  beforeEach(() => {
    apiMock.coverage.mockReset().mockResolvedValue(payload);
    apiMock.heatmap.mockReset().mockResolvedValue(heatmapPayload);
    apiMock.targets.mockReset().mockResolvedValue({
      items: [{ id: 'g1', name: '目标甲' }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
  });

  it('显示说明与「未测试不等于安全」提示，并默认展示智能体页签的条目与状态徽章', async () => {
    renderPage();
    expect(await screen.findByText(/智能体目标劫持（Agent Goal Hijack）/)).toBeInTheDocument();
    // 副标题与黄色横幅不再重复同一句话：这句话只出现一次
    expect(screen.getAllByText(/覆盖矩阵回答：每条风险标准你测了没有、测出了什么/)).toHaveLength(1);
    expect(
      screen.getByText(/未测试不等于安全/, { selector: 'p.bg-severity-medium-bg' }),
    ).toBeInTheDocument();
    const badge = (id: string) =>
      within(screen.getByTestId(`row-${id}`)).getByText(/./, { selector: '[data-status]' });
    expect(badge('ASI01')).toHaveTextContent('已测·发现风险');
    expect(badge('ASI02')).toHaveTextContent('已测·未发现风险');
    expect(badge('ASI03')).toHaveTextContent('未测试');
    expect(badge('ASI04')).toHaveTextContent('平台暂不覆盖');
    expect(badge('ASI04').className).toMatch(/border-dashed/);
    expect(within(screen.getByTestId('row-ASI01')).getByText('样本充足')).toBeInTheDocument();
    expect(within(screen.getByTestId('row-ASI02')).getByText(/样本偏少/)).toBeInTheDocument();
    expect(screen.queryByText(/提示词注入（Prompt Injection）/)).not.toBeInTheDocument();
    expect(apiMock.coverage).toHaveBeenCalledWith({
      taskId: undefined,
      targetId: undefined,
      days: undefined,
    });
  });

  it('四个页签切换只显示各自框架的条目，国标附录 A 页签已移除并指向新页', async () => {
    renderPage();
    await screen.findByText(/智能体目标劫持/);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'OWASP 智能体十大风险',
      'OWASP 大模型十大风险',
      'MITRE ATLAS',
      '按评估对象热力图',
    ]);
    await userEvent.click(screen.getByRole('tab', { name: 'OWASP 大模型十大风险' }));
    expect(screen.getByText('提示词注入（Prompt Injection）')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '国标附录 A' })).not.toBeInTheDocument();
    expect(screen.queryByText('违反社会主义核心价值观的内容')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /国际框架（参考）/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '国内标准条款' })).toHaveAttribute(
      'href',
      '/reports/standard-clauses',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'MITRE ATLAS' }));
    expect(screen.getByText('大模型提示词注入（LLM Prompt Injection）')).toBeInTheDocument();
  });

  it('旧书签 framework=GBT45654_ANNEX_A 跳到国内标准条款页', async () => {
    renderPage('/reports/framework-coverage?framework=GBT45654_ANNEX_A');
    await waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent('/reports/standard-clauses?line=content'),
    );
  });

  it('点击行展开关联风险类别与最近任务链接', async () => {
    renderPage();
    await userEvent.click(await screen.findByTestId('row-ASI01'));
    const detail = screen.getByTestId('detail-ASI01');
    expect(within(detail).getByText(/提示词注入\/越狱风险：12 题/)).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: '示例任务一' })).toHaveAttribute(
      'href',
      '/eval-tasks/t1',
    );
    await userEvent.click(screen.getByTestId('row-ASI04'));
    expect(screen.getByText('平台暂不覆盖：示例原因')).toBeInTheDocument();
  });

  it('带 taskId 进入时按单个任务请求并可回到全部任务', async () => {
    renderPage('/reports/framework-coverage?taskId=t1&framework=OWASP_LLM');
    await screen.findByText('提示词注入（Prompt Injection）');
    expect(apiMock.coverage).toHaveBeenCalledWith({
      taskId: 't1',
      targetId: undefined,
      days: undefined,
    });
    expect(screen.getByText(/仅统计单个任务/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看全部任务' }));
    await waitFor(() =>
      expect(apiMock.coverage).toHaveBeenLastCalledWith({
        taskId: undefined,
        targetId: undefined,
        days: undefined,
      }),
    );
  });

  it('评估对象与时间窗筛选会重新请求', async () => {
    renderPage();
    await screen.findByText(/智能体目标劫持/);
    await userEvent.selectOptions(screen.getByLabelText('时间窗'), '30');
    await waitFor(() =>
      expect(apiMock.coverage).toHaveBeenLastCalledWith({
        taskId: undefined,
        targetId: undefined,
        days: 30,
      }),
    );
    await userEvent.selectOptions(await screen.findByLabelText('评估对象'), 'g1');
    await waitFor(() =>
      expect(apiMock.coverage).toHaveBeenLastCalledWith({
        taskId: undefined,
        targetId: 'g1',
        days: 30,
      }),
    );
  });

  describe('热力图页签', () => {
    const open = async () => {
      renderPage('/reports/framework-coverage?framework=HEATMAP&hmFramework=ATLAS_MATRIX');
      await screen.findByTestId('heat-row-AML.T0051');
    };

    it('旧路由重定向到热力图页签并保留框架参数', async () => {
      renderPage('/risk/framework-map?framework=OWASP_LLM');
      await screen.findByTestId('heatmap-panel');
      expect(screen.getByTestId('loc')).toHaveTextContent(
        '/reports/framework-coverage?framework=HEATMAP&hmFramework=OWASP_LLM',
      );
      expect(screen.getByRole('tab', { name: '按评估对象热力图' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(apiMock.heatmap).toHaveBeenCalledWith({ framework: 'OWASP_LLM', dimension: 'target' });
    });

    it('点击页签切到热力图，不触发覆盖矩阵的筛选区', async () => {
      renderPage();
      await screen.findByText(/智能体目标劫持/);
      await userEvent.click(screen.getByRole('tab', { name: '按评估对象热力图' }));
      expect(await screen.findByTestId('heatmap-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('coverage-summary')).not.toBeInTheDocument();
    });

    it('默认隐藏无数据条目，开关打开后显示，并带图例', async () => {
      await open();
      expect(screen.queryByTestId('heat-row-AML.TA.R')).not.toBeInTheDocument();
      expect(screen.getByText(/已隐藏 2 条所有对象都没有数据的条目/)).toBeInTheDocument();
      expect(screen.getByText(/无数据（未测试，不等于安全）/)).toBeInTheDocument();
      expect(screen.getByText('已测·无风险')).toBeInTheDocument();
      await userEvent.click(screen.getByLabelText('显示未测试条目'));
      expect(screen.getByTestId('heat-row-AML.TA.R')).toBeInTheDocument();
      expect(screen.getByTestId('heat-row-AML.T0109')).toBeInTheDocument();
    });

    it('中文名为主、英文原名为辅；无译名时保留英文，并注明以官方英文名为准', async () => {
      await open();
      const row = screen.getByTestId('heat-row-AML.T0051');
      expect(within(row).getByText('大模型提示词注入')).toBeInTheDocument();
      expect(within(row).getByText('LLM Prompt Injection')).toBeInTheDocument();
      expect(within(row).getByText('战术：执行')).toBeInTheDocument();
      await userEvent.click(screen.getByLabelText('显示未测试条目'));
      const raw = screen.getByTestId('heat-row-AML.T0109');
      expect(within(raw).getByText('AI Supply Chain Rug Pull')).toBeInTheDocument();
      expect(screen.getByText(/中文名为平台译名，以 MITRE 官方英文名为准/)).toBeInTheDocument();
    });

    it('未映射告警可展开，说明不代表没有风险并列出类别', async () => {
      await open();
      const toggle = screen.getByRole('button', { name: /有 123 条结果未映射/ });
      expect(screen.queryByTestId('unmapped-detail')).not.toBeInTheDocument();
      await userEvent.click(toggle);
      const detail = screen.getByTestId('unmapped-detail');
      expect(within(detail).getByText(/不代表没有风险/)).toBeInTheDocument();
      expect(within(detail).getByText('内容安全风险：100 条')).toBeInTheDocument();
      expect(within(detail).getByText('一般安全风险：23 条')).toBeInTheDocument();
    });
  });
});
