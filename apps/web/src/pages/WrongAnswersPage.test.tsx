import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { WrongAnswersPage } from './WrongAnswersPage';
import samples from '../../../api/test/fixtures/wrong-answer-groups.json';
import { groupWrongAnswers, type RiskSample } from '../../../api/src/modules/wrong-answers/groups';

const apiMock = vi.hoisted(() => ({ groups: vi.fn(), group: vi.fn(), export: vi.fn(), retestFailed: vi.fn(), review: vi.fn(), allowed: true }));
vi.mock('@/lib/api', () => ({ api: {
  wrongAnswers: { groups: apiMock.groups, group: apiMock.group, export: apiMock.export },
  evalTasks: { retestFailed: apiMock.retestFailed }, remediation: { review: apiMock.review },
} }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => apiMock.allowed }) }));
/** 当前地址栏参数，断言筛选是否写回 URL。 */
function SearchProbe() {
  return <output data-testid="search">{useLocation().search}</output>;
}
function renderPage(initial = '/wrong-answers?taskId=t1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><MemoryRouter initialEntries={[initial]}><WrongAnswersPage /><SearchProbe /></MemoryRouter></ToastProvider></QueryClientProvider>);
}
const search = () => new URLSearchParams(screen.getByTestId('search').textContent ?? '');
function row(overrides = {}) {
  return { id: 'g1', title: '诱导读取敏感文件', severity: 'HIGH', sampleCount: 3,
    targets: { names: ['客服模型'], count: 1 }, latestAt: '2026-10-03T01:00:00Z', status: '待确认', suspectedFalsePositive: 1, ...overrides };
}
function detail(overrides = {}) {
  return { ...row(), representative: { id: 'w1', questionContent: '典型题面', modelResponse: '我不能执行此请求',
    modelStance: 'refused', modelReaction: '模型明确拒绝了诱导请求', sandboxBlocked: false, suspectedFalsePositive: true,
    reason: '模型已明确拒绝，只是回答里复述了测试暗号' }, observations: [{ targetName: '客服模型', createdAt: '2026-10-03T01:00:00Z' }],
    remediation: ['限制敏感文件读取'], findingRefs: [{ taskId: 't1', findingId: 'f1' }, { taskId: 't2', findingId: 'f2' }],
    actionable: true, retestPlan: [], members: { items: ['w1'], total: 3, page: 1, pageSize: 15 }, ...overrides };
}
beforeEach(() => {
  for (const fn of [apiMock.groups, apiMock.group, apiMock.export, apiMock.retestFailed, apiMock.review]) fn.mockReset();
  apiMock.allowed = true;
  apiMock.groups.mockResolvedValue({ items: [row()], total: 1, page: 1, pageSize: 15, counts: { 待确认: 1, 整改中: 0, 已关闭: 0 } });
  apiMock.group.mockResolvedValue(detail());
  apiMock.export.mockResolvedValue(undefined);
  apiMock.review.mockResolvedValue({});
});

describe('WrongAnswersPage 风险等级筛选', () => {
  it('等级下拉展示五档中文，不露英文枚举（原 chips 改为样稿下拉）', async () => {
    renderPage();
    const select = screen.getByRole('combobox', { name: '风险等级' });
    for (const name of ['严重', '高危', '中危', '低危', '提示']) expect(within(select).getByRole('option', { name })).toBeInTheDocument();
    expect(screen.queryByText('HIGH')).not.toBeInTheDocument();
    await screen.findByText('诱导读取敏感文件');
  });
  it('选择高危按 HIGH 过滤问题', async () => {
    renderPage();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '风险等级' }), 'HIGH');
    await waitFor(() => expect(apiMock.groups).toHaveBeenLastCalledWith(expect.objectContaining({ severity: ['HIGH'], taskId: 't1' })));
  });
  it('保留智能体工具风险深链范围，取消多余的页面标签', async () => {
    renderPage('/wrong-answers?taskId=t1&agentRisk=true');
    await waitFor(() => expect(apiMock.groups).toHaveBeenCalledWith(expect.objectContaining({ agentRisk: true, taskId: 't1' })));
  });
  it('导出携带等级和发现范围', async () => {
    renderPage('/wrong-answers?taskId=t1&findingIds=f1');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '风险等级' }), 'HIGH');
    await userEvent.click(screen.getByRole('button', { name: '导出' }));
    await waitFor(() =>
      expect(apiMock.export).toHaveBeenCalledWith('t1', ['HIGH'], false, 'f1', {
        domain: undefined,
        since: undefined,
        until: undefined,
      }),
    );
  });
});
describe('WrongAnswersPage 发起失败用例复测', () => {
  it('现有接口不能按问题筛选原样本，隐藏复测按钮及验证承诺，不调用扩大范围的接口', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '诱导读取敏感文件' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).queryByRole('button', { name: /复测/ })).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/全部不再触发才能关闭/)).not.toBeInTheDocument();
    expect(apiMock.retestFailed).not.toHaveBeenCalled();
  });
});
describe('WrongAnswersPage 风险类别列与判定依据列', () => {
  it('问题标题使用受控中文，不展示内部类别或判定来源', async () => {
    renderPage();
    const tr = (await screen.findByRole('button', { name: '诱导读取敏感文件' })).closest('tr')!;
    expect(within(tr).getByText('1 疑似误报')).toBeInTheDocument();
    expect(tr.textContent).not.toMatch(/llm_judge|agent_tool_abuse/);
    expect(within(tr).getByText('10-03')).toHaveClass('whitespace-nowrap');
  });
});
describe('WrongAnswersPage 顶部横幅与复核状态筛选', () => {
  it('未选任务时导出不可用，明确给出操作办法，移除长横幅', async () => {
    renderPage('/wrong-answers');
    const button = screen.getByRole('button', { name: '导出' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', '先在评估任务中选择任务');
    await screen.findByText('诱导读取敏感文件');
  });
  it('任务深链保留范围并支持查看全部问题', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: '查看全部问题' }));
    await waitFor(() => expect(apiMock.groups.mock.calls.at(-1)![0].taskId).toBeUndefined());
  });
  it('默认待确认，用分段标签展示准确数量', async () => {
    renderPage('/wrong-answers');
    await waitFor(() => expect(apiMock.groups).toHaveBeenCalledWith(expect.objectContaining({ status: '待确认' })));
    expect(await screen.findByRole('tab', { name: '待确认 1' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '整改中 0' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '已关闭 0' })).toBeInTheDocument();
  });
  it('旧 reviewStatus 具体状态透传，all 映射全部问题', async () => {
    const { unmount } = renderPage('/wrong-answers?reviewStatus=CONFIRMED,FALSE_POSITIVE');
    await waitFor(() => expect(apiMock.groups).toHaveBeenCalledWith(expect.objectContaining({ reviewStatus: ['CONFIRMED', 'FALSE_POSITIVE'], status: '全部' })));
    unmount();
    renderPage('/wrong-answers?reviewStatus=all');
    await waitFor(() => expect(apiMock.groups).toHaveBeenLastCalledWith(expect.objectContaining({ status: '全部', reviewStatus: undefined })));
  });
  it('切换全部清除旧 reviewStatus 范围并重新查询', async () => {
    renderPage('/wrong-answers?reviewStatus=CONFIRMED');
    await userEvent.click(screen.getByRole('tab', { name: '全部' }));
    await waitFor(() => expect(apiMock.groups).toHaveBeenLastCalledWith(expect.objectContaining({ status: '全部', reviewStatus: undefined })));
  });
});
describe('WrongAnswersPage 风险样本详情', () => {
  it('右抽屉展示典型样本、模型反应、对象时间和整改建议，避免内部键', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '诱导读取敏感文件' }));
    const dialog = await screen.findByRole('dialog');
    for (const label of ['典型样本', '典型题面', '模型明确拒绝了诱导请求', '限制敏感文件读取']) expect(within(dialog).getByText(label)).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/content_safety|rule-judge|openai-compatible|refused/);
  });
  it('没有样本快照的终端发现仍可查看，无关联发现时不提供状态操作', async () => {
    apiMock.group.mockResolvedValue(detail({ representative: { questionContent: '', modelResponse: null, modelReaction: '终端体检发现' }, actionable: false, findingRefs: [] }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '诱导读取敏感文件' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('没有样本快照')).toBeInTheDocument();
    expect(within(dialog).getByText('终端体检发现')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '判为误报' })).not.toBeInTheDocument();
  });
  it('判为误报操作覆盖全部关联发现，成功后刷新问题状态', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '诱导读取敏感文件' }));
    await userEvent.click(await screen.findByRole('button', { name: '判为误报' }));
    await waitFor(() => expect(apiMock.review).toHaveBeenCalledTimes(2));
    expect(apiMock.review).toHaveBeenCalledWith('f1', { status: 'FALSE_POSITIVE', reason: '人工确认误报' });
    expect(apiMock.review).toHaveBeenCalledWith('f2', { status: 'FALSE_POSITIVE', reason: '人工确认误报' });
    expect(await screen.findByText('已将 2 条发现判为误报')).toBeInTheDocument();
  });
  it('确认风险沿用已有复核流转，不直接宣称已整改关闭', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '诱导读取敏感文件' }));
    await userEvent.click(await screen.findByRole('button', { name: '确认风险' }));
    await waitFor(() => expect(apiMock.review).toHaveBeenCalledWith('f1', { status: 'CONFIRMED', reason: '人工确认风险' }));
  });
  it('只读用户看不到状态操作', async () => {
    apiMock.allowed = false;
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '诱导读取敏感文件' }));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: '确认风险' })).not.toBeInTheDocument();
  });
  it('抽屉可用 Escape 关闭并返回行按钮焦点', async () => {
    renderPage();
    const trigger = await screen.findByRole('button', { name: '诱导读取敏感文件' });
    await userEvent.click(trigger);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
describe('WrongAnswersPage 大样本与异常', () => {
  it('91 条夹具经真实归并后渲染 11 行，首屏不超过15条', async () => {
    const groups = groupWrongAnswers(samples as RiskSample[]);
    apiMock.groups.mockResolvedValue({ items: groups, total: groups.length, page: 1, pageSize: 15, counts: { 待确认: 11, 整改中: 0, 已关闭: 0 } });
    renderPage();
    await screen.findByRole('button', { name: '多语言安全评测未通过' });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(12);
    expect(groups.reduce((n, g) => n + g.sampleCount, 0)).toBe(91);
    expect(apiMock.groups).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 15 }));
  });
  it('空状态只显示没有待处理的风险', async () => {
    apiMock.groups.mockResolvedValue({ items: [], total: 0, counts: {} });
    renderPage();
    expect(await screen.findByText('没有待处理的风险')).toBeInTheDocument();
  });
  it('加载失败明确提示，避免误显示空状态', async () => {
    apiMock.groups.mockRejectedValue(new Error('网络不可用'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('风险问题加载失败');
    expect(screen.queryByText('没有待处理的风险')).not.toBeInTheDocument();
  });
});

describe('WrongAnswersPage 行交互与日期', () => {
  it('点击行内样本数也能打开抽屉', async () => {
    renderPage();
    const tr = (await screen.findByRole('button', { name: '诱导读取敏感文件' })).closest('tr')!;
    await userEvent.click(within(tr).getByText('3'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
  it('跨日发现按北京时间展示 MM-DD，抽屉同口径', async () => {
    apiMock.groups.mockResolvedValue({ items: [row({ latestAt: '2026-09-05T21:00:00Z' })], total: 1, counts: {} });
    apiMock.group.mockResolvedValue(detail({ observations: [{ targetName: '客服模型', createdAt: '2026-09-05T21:00:00Z' }] }));
    renderPage();
    const tr = (await screen.findByRole('button', { name: '诱导读取敏感文件' })).closest('tr')!;
    expect(within(tr).getByText('09-06')).toBeInTheDocument();
    await userEvent.click(within(tr).getByRole('button'));
    expect(within(await screen.findByRole('dialog')).getByText('2026-09-06')).toBeInTheDocument();
  });
});
describe('WrongAnswersPage 首页下钻参数', () => {
  it('带 severity 参数时初始化等级筛选，reviewStatus=all 看全部状态', async () => {
    renderPage('/wrong-answers?severity=CRITICAL&reviewStatus=all');
    await waitFor(() => expect(apiMock.groups).toHaveBeenLastCalledWith(expect.objectContaining({ severity: ['CRITICAL'], status: '全部' })));
    expect(screen.getByRole('combobox', { name: '风险等级' })).toHaveValue('CRITICAL');
  });
  it('带 domain 参数时初始化风险类别筛选并按类别查询，详情同范围', async () => {
    renderPage('/wrong-answers?domain=prompt_injection&reviewStatus=all');
    await waitFor(() => expect(apiMock.groups).toHaveBeenLastCalledWith(expect.objectContaining({ domain: 'prompt_injection', status: '全部' })));
    const select = screen.getByRole('combobox', { name: '风险类别' });
    expect(select).toHaveValue('prompt_injection');
    expect(within(select).getByRole('option', { name: '提示词注入/越狱风险' })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: '诱导读取敏感文件' }));
    await waitFor(() => expect(apiMock.group).toHaveBeenCalledWith('g1', expect.objectContaining({ domain: 'prompt_injection' })));
  });
  it('切换风险类别重新查询；不认识的类别不带', async () => {
    const { unmount } = renderPage('/wrong-answers?domain=prompt_injection');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '风险类别' }), '');
    await waitFor(() => expect(apiMock.groups.mock.calls.at(-1)![0].domain).toBeUndefined());
    unmount();
    renderPage('/wrong-answers?domain=not_a_domain');
    await waitFor(() => expect(apiMock.groups).toHaveBeenCalled());
    expect(apiMock.groups.mock.calls.at(-1)![0].domain).toBeUndefined();
    expect(screen.getByRole('combobox', { name: '风险类别' })).toHaveValue('');
  });
});

describe('WrongAnswersPage 首页下钻的时间范围与口径', () => {
  const ACTIVE = 'UNREVIEWED,NEEDS_REVIEW,CONFIRMED,ACCEPTED_RISK';
  const NOV_1 = '2026-10-31T16:00:00.000Z';
  it('排除误报的状态写法透传，带 since 时显示可清除的「起」日期标签', async () => {
    renderPage(`/wrong-answers?severity=HIGH&since=${NOV_1}&reviewStatus=${ACTIVE}`);
    await waitFor(() => expect(apiMock.groups).toHaveBeenLastCalledWith(expect.objectContaining({
      severity: ['HIGH'], since: NOV_1, status: '全部', reviewStatus: ACTIVE.split(','),
    })));
    expect(screen.getByText('11-01 起')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '清除日期' }));
    await waitFor(() => expect(apiMock.groups.mock.calls.at(-1)![0].since).toBeUndefined());
    expect(screen.queryByText('11-01 起')).not.toBeInTheDocument();
    expect(search().has('since')).toBe(false);
    expect(search().get('reviewStatus')).toBe(ACTIVE);
  });
  it('带 until 时：同一天显示单日，跨多天显示起止', async () => {
    const { unmount } = renderPage('/wrong-answers?since=2026-10-19T16:00:00.000Z&until=2026-10-20T16:00:00.000Z');
    await waitFor(() => expect(apiMock.groups).toHaveBeenLastCalledWith(expect.objectContaining({
      since: '2026-10-19T16:00:00.000Z', until: '2026-10-20T16:00:00.000Z' })));
    expect(screen.getByText('10-20')).toBeInTheDocument();
    unmount();
    renderPage(`/wrong-answers?since=${NOV_1}&until=2026-11-05T16:00:00.000Z`);
    expect(await screen.findByText('11-01～11-05')).toBeInTheDocument();
  });
  it('不认识的日期忽略', async () => {
    renderPage('/wrong-answers?since=not-a-date');
    await waitFor(() => expect(apiMock.groups).toHaveBeenCalled());
    expect(apiMock.groups.mock.calls.at(-1)![0].since).toBeUndefined();
    expect(screen.queryByRole('button', { name: '清除日期' })).not.toBeInTheDocument();
  });
  it('改风险类别下拉写回 URL', async () => {
    renderPage('/wrong-answers?reviewStatus=all');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '风险类别' }), 'privacy_leakage');
    await waitFor(() => expect(search().get('domain')).toBe('privacy_leakage'));
    expect(apiMock.groups).toHaveBeenLastCalledWith(expect.objectContaining({ domain: 'privacy_leakage' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '风险类别' }), '');
    await waitFor(() => expect(search().has('domain')).toBe(false));
    expect(search().get('reviewStatus')).toBe('all');
  });
  it('「查看全部问题」同时重置类别和日期', async () => {
    renderPage(`/wrong-answers?domain=prompt_injection&since=${NOV_1}`);
    await userEvent.click(await screen.findByRole('button', { name: '查看全部问题' }));
    await waitFor(() => {
      const last = apiMock.groups.mock.calls.at(-1)![0];
      expect(last.domain).toBeUndefined();
      expect(last.since).toBeUndefined();
    });
    expect(screen.getByRole('combobox', { name: '风险类别' })).toHaveValue('');
    expect(screen.queryByText('11-01 起')).not.toBeInTheDocument();
  });
  it('选了类别或日期时导出带上它们', async () => {
    renderPage(`/wrong-answers?taskId=t1&domain=prompt_injection&since=${NOV_1}`);
    const button = screen.getByRole('button', { name: '导出' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(apiMock.export).toHaveBeenCalled());
    const call = apiMock.export.mock.calls.at(-1)!;
    expect(call[0]).toBe('t1');
    expect(call[4]).toEqual({ domain: 'prompt_injection', since: NOV_1, until: undefined });
  });
});
