import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardPosture } from '@/lib/api';
import { ActionList, buildActions, rowDividerClass, type ActionInputs } from './ActionList';
import { DashCard } from './DashCard';
import { KpiCard, Sparkline } from './KpiCard';
import {
  ChangeTags,
  PostureHero,
  PostureSentence,
  ScoreRing,
  splitClauses,
  type HeroStats,
} from './PostureHero';
import { CategoryTop } from './CategoryTop';
import { RiskDistribution } from './RiskDistribution';
import { TopTasks } from './TopTasks';
import { niceAxis, TrendChart } from './TrendChart';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

const basePosture: DashboardPosture = {
  riskLevel: 'HIGH',
  riskLevelLabel: '高',
  score: 58,
  levelBasis: '存在 2 项严重风险',
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
const stats: HeroStats = {
  taskTotal: 14,
  periodTaskCount: 6,
  completedCount: 5,
  findingTotal: 22,
  severity: { high: 14, medium: 5, low: 3 },
  targetCount: 8,
  connectionIssues: 0,
  untested: 4,
  sampleTotal: 100295,
};
const ok = { isLoading: false, isError: false };

describe('PostureHero', () => {
  it('有分数时画评分环；score 为 0 也是有效分数', () => {
    const { rerender } = wrap(
      <PostureHero posture={basePosture} postureState={ok} range="month" stats={stats} />,
    );
    expect(screen.getByTestId('score-ring')).toHaveAttribute('aria-label', '综合评分 58 分');
    rerender(
      <MemoryRouter>
        <PostureHero
          posture={{ ...basePosture, score: 0 }}
          postureState={ok}
          range="month"
          stats={stats}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('score-ring')).toHaveAttribute('aria-label', '综合评分 0 分');
  });

  it('score 为 null 不画评分环，改显示等级徽章与依据', () => {
    wrap(
      <PostureHero
        posture={{ ...basePosture, score: null, levelBasis: '有效判定不足' }}
        postureState={ok}
        range="month"
        stats={stats}
      />,
    );
    expect(screen.queryByTestId('score-ring')).not.toBeInTheDocument();
    expect(screen.getByTestId('level-badge')).toHaveTextContent('总体风险：高');
    expect(screen.getByText('有效判定不足')).toBeInTheDocument();
  });

  it('UNRATED 显示「暂无法评级」而不是低风险', () => {
    wrap(
      <PostureHero
        posture={{ ...basePosture, riskLevel: 'UNRATED', riskLevelLabel: '无', score: null }}
        postureState={ok}
        range="month"
        stats={stats}
      />,
    );
    const badge = screen.getByTestId('level-badge');
    expect(badge).toHaveTextContent('暂无法评级');
    expect(badge).not.toHaveTextContent('低');
  });

  it('fewValid 时提示样本偏少', () => {
    wrap(
      <PostureHero
        posture={{ ...basePosture, fewValid: true }}
        postureState={ok}
        range="all"
        stats={stats}
      />,
    );
    expect(screen.getByLabelText('总体风险态势')).toHaveTextContent(
      '有效判定样本偏少，评级仅供参考',
    );
  });

  it('加载失败时显示重试且可点击', () => {
    const onRetry = vi.fn();
    wrap(<PostureHero postureState={{ isError: true, onRetry }} range="month" stats={stats} />);
    fireEvent.click(screen.getByRole('button', { name: /加载失败 · 重试/ }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('态势句：按范围生成文案，无高危时不写需优先处置', () => {
    const { container, rerender } = render(<PostureSentence posture={basePosture} range="7d" />);
    expect(container).toHaveTextContent('近 7 天已发起评估 9 项、完成 7 项');
    rerender(
      <PostureSentence
        posture={{ ...basePosture, facts: { ...basePosture.facts, highCount: 0 } }}
        range="all"
      />,
    );
    expect(container).toHaveTextContent('累计已发起评估');
    expect(container).toHaveTextContent('暂无高危风险回复');
    expect(container).not.toHaveTextContent('需优先处置');
  });

  it('四个关键数中缺失的数据不显示数字（显示 —）', () => {
    wrap(
      <PostureHero
        posture={basePosture}
        postureState={ok}
        range="month"
        stats={{ ...stats, targetCount: null, sampleTotal: null }}
      />,
    );
    expect(screen.getAllByText('—').length).toBe(2);
    expect(screen.queryByText('100,295')).not.toBeInTheDocument();
  });
});

describe('ChangeTags：null 一律不显示', () => {
  it('全部为 null 时整组不渲染', () => {
    const { container } = render(
      <ChangeTags
        range="month"
        changes={{ newFindings: null, highShare: null, avgReviewHours: null }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('avgReviewHours 为 null 不显示；delta 为 null（全部范围）不显示变化箭头', () => {
    const { container } = render(
      <ChangeTags
        range="all"
        changes={{
          newFindings: { current: 22, previous: null, delta: null },
          highShare: { current: 0.5, previous: null, delta: null },
          avgReviewHours: { current: null, previous: null },
        }}
      />,
    );
    expect(container).not.toHaveTextContent('平均复核时长');
    expect(container).not.toHaveTextContent('新增风险回复');
    expect(container).toHaveTextContent('高危占比 50.0%');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('有值时展示方向与数值', () => {
    const { container } = render(
      <ChangeTags
        range="month"
        changes={{
          newFindings: { current: 5, previous: 8, delta: -3 },
          highShare: { current: 0.2, previous: 0.1, delta: 0.1 },
          avgReviewHours: { current: 1.8, previous: 2.4, sampleSize: { current: 3, previous: 4 } },
        }}
      />,
    );
    expect(container).toHaveTextContent('新增风险回复 -3');
    expect(container).toHaveTextContent('高危占比 20.0% +10.0 个百分点');
    expect(container).toHaveTextContent('平均复核时长 1.8 小时');
  });
});

describe('ScoreRing', () => {
  it('分数超出范围时不溢出（夹紧到 0-100）', () => {
    wrap(<ScoreRing score={130} level="LOW" />);
    expect(screen.getByTestId('score-ring')).toBeInTheDocument();
  });
});

describe('KpiCard', () => {
  it('零值显示绿色已清零文案，非零显示数字并可跳转', () => {
    const { rerender } = wrap(
      <KpiCard
        icon={<i />}
        title="待整改到期"
        tone="high"
        value={0}
        to="/my-todos"
        zeroText="已清零"
      />,
    );
    expect(screen.getByText('已清零')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <KpiCard
          icon={<i />}
          title="待整改到期"
          tone="high"
          value={4}
          to="/my-todos"
          zeroText="已清零"
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText('已清零')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '待整改到期 4' })).toHaveAttribute('href', '/my-todos');
  });

  it('value 为 null 时不显示数字', () => {
    wrap(
      <KpiCard
        icon={<i />}
        title="接入异常"
        tone="critical"
        value={null}
        to="/x"
        zeroText="均正常"
      />,
    );
    expect(screen.getByRole('link', { name: '接入异常' })).toHaveTextContent('—');
    expect(screen.queryByText('均正常')).not.toBeInTheDocument();
  });
});

describe('Sparkline', () => {
  const pts = [
    { date: '2026-10-19', value: 3 },
    { date: '2026-10-20', value: 1 },
  ];
  it('少于两个点不绘制', () => {
    const { container } = render(
      <Sparkline points={[pts[0]!]} color="#B04A05" hint="当日新增且仍待复核" unit="条" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
  it('悬停提示写明口径', () => {
    render(<Sparkline points={pts} color="#B04A05" hint="当日新增且仍待复核" unit="条" />);
    const svg = screen.getByRole('img');
    svg.getBoundingClientRect = () => ({
      left: 0,
      width: 132,
      top: 0,
      height: 40,
      right: 132,
      bottom: 40,
      x: 0,
      y: 0,
      toJSON() {},
    });
    fireEvent.mouseMove(svg, { clientX: 0 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('10/19 当日新增且仍待复核：3 条');
  });
});

describe('ActionList', () => {
  const clear: ActionInputs = {
    highCount: 0,
    highTaskCount: 0,
    reviewCount: 0,
    remediationCount: 0,
    connectionCount: 0,
    untestedCount: 0,
    targetCount: 3,
    gateCount: 0,
    gateVisible: true,
    modelFileCount: 0,
    canDispose: true,
  };
  it('全部清零时显示「已清零」空状态', () => {
    wrap(<ActionList inputs={clear} state={ok} />);
    expect(screen.getByText('已清零')).toBeInTheDocument();
    expect(screen.getByText('暂无需要你处理的事项')).toBeInTheDocument();
  });
  it('数据未取到时不把未知当作已清零', () => {
    const r = buildActions({ ...clear, reviewCount: null });
    expect(r.unknown).toBe(true);
    wrap(<ActionList inputs={{ ...clear, reviewCount: null }} state={ok} />);
    expect(screen.queryByText('暂无需要你处理的事项')).not.toBeInTheDocument();
  });
  it('无门禁权限时门禁不参与已清零汇总', () => {
    const r = buildActions({ ...clear, gateVisible: false, gateCount: null, remediationCount: 2 });
    expect(r.cleared).toEqual(['接入异常']);
    expect(r.unknown).toBe(false);
  });
  it('无处置权限时高危处置回退到我的待办', () => {
    const r = buildActions({ ...clear, highCount: 3, canDispose: false });
    expect(r.items[0]!.to).toBe('/my-todos');
  });
});

describe('DashCard', () => {
  it('失败只替换本卡内容并可重试', () => {
    const onRetry = vi.fn();
    wrap(
      <DashCard title="风险类别" state={{ isError: true, onRetry }}>
        <div>正文</div>
      </DashCard>,
    );
    expect(screen.queryByText('正文')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /加载失败 · 重试/ }));
    expect(onRetry).toHaveBeenCalled();
  });
  it('加载中显示骨架', () => {
    wrap(
      <DashCard title="风险类别" state={{ isLoading: true }}>
        <div>正文</div>
      </DashCard>,
    );
    expect(screen.getByLabelText('加载中')).toBeInTheDocument();
  });
});

describe('RiskDistribution', () => {
  it('图例显示数量与占比，且为 0 的等级不显示', () => {
    wrap(
      <RiskDistribution
        counts={{ CRITICAL: 0, HIGH: 12, MEDIUM: 3, LOW: 90, INFO: 0 }}
        periodLabel="本月"
        state={ok}
      />,
    );
    expect(screen.getByText('105')).toBeInTheDocument();
    expect(screen.getByText('11.4%')).toBeInTheDocument();
    expect(screen.getByText('85.7%')).toBeInTheDocument();
    expect(screen.queryByText('严重')).not.toBeInTheDocument();
  });
});

describe('TrendChart', () => {
  it('niceAxis 给出整数刻度并包含最大值', () => {
    expect(niceAxis(0).top).toBe(1);
    expect(niceAxis(8)).toEqual({ top: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceAxis(45).top).toBeGreaterThanOrEqual(45);
  });
  it('全 0 数据显示空状态', () => {
    wrap(
      <TrendChart
        state={ok}
        trend={{
          days: 30,
          timezone: 'Asia/Shanghai',
          points: [{ date: '2026-10-01', findings: 0, high: 0, pendingReview: 0 }],
        }}
      />,
    );
    expect(screen.getByText('近 30 天暂无风险回复')).toBeInTheDocument();
  });
  it('有数据时标注峰值并可悬停查看当日明细', () => {
    wrap(
      <TrendChart
        state={ok}
        trend={{
          days: 30,
          timezone: 'Asia/Shanghai',
          points: [
            { date: '2026-10-18', findings: 2, high: 0, pendingReview: 0 },
            { date: '2026-10-19', findings: 8, high: 3, pendingReview: 1 },
            { date: '2026-10-20', findings: 1, high: 0, pendingReview: 0 },
          ],
        }}
      />,
    );
    expect(screen.getByText('10/19 峰值 8')).toBeInTheDocument();
    const svg = screen.getByRole('img', { name: /风险回复共 11 条/ });
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
    fireEvent.mouseMove(svg, { clientX: 320 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('其中高危（含严重）：3 条');
  });
  const threeDays = {
    days: 30,
    timezone: 'Asia/Shanghai',
    points: [
      { date: '2026-10-18', findings: 2, high: 0, pendingReview: 0 },
      { date: '2026-10-19', findings: 8, high: 3, pendingReview: 1 },
      { date: '2026-10-20', findings: 1, high: 0, pendingReview: 0 },
    ],
  };
  it('可下钻时每天都能用键盘聚焦，聚焦时显示当日明细', () => {
    const dayHref = vi.fn((date: string) => `/x?d=${date}`);
    wrap(<TrendChart state={ok} trend={threeDays} dayHref={dayHref} />);
    const days = screen.getAllByRole('link');
    expect(days.map((el) => el.getAttribute('aria-label'))).toEqual([
      '10/18 风险回复 2 条',
      '10/19 风险回复 8 条',
      '10/20 风险回复 1 条',
    ]);
    fireEvent.focus(days[1]!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('2026-10-19');
  });
  it('不可下钻时（无权限）没有可聚焦的点，点击也不跳转', () => {
    wrap(<TrendChart state={ok} trend={threeDays} />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByRole('img', { name: /风险回复共 11 条/ })).not.toHaveStyle({
      cursor: 'pointer',
    });
  });
});

describe('PostureHero 口径文案', () => {
  it('态势句：周期前缀一致，不再「累计」与「本月」混用', () => {
    const { container, rerender } = render(<PostureSentence posture={basePosture} range="month" />);
    expect(container).toHaveTextContent('本月已发起评估 9 项、完成 7 项');
    expect(container).toHaveTextContent('本月识别风险回复 22 条');
    expect(container).not.toHaveTextContent('累计');
    rerender(<PostureSentence posture={basePosture} range="all" />);
    expect(container).toHaveTextContent('累计已发起评估');
    expect(container).toHaveTextContent('累计识别风险回复 22 条');
  });

  it('本月变化旁标注对比基准', () => {
    wrap(
      <ChangeTags
        range="month"
        changes={{
          newFindings: { current: 5, previous: 8, delta: -3 },
          highShare: null,
          avgReviewHours: null,
        }}
      />,
    );
    expect(screen.getByTestId('change-baseline')).toHaveTextContent('对比上月同期');
  });

  it('样本资产：大数字是规则库题目数，副标题只写运行记录，不重复规则库的题集套数', () => {
    wrap(
      <PostureHero
        posture={basePosture}
        postureState={ok}
        range="month"
        stats={{ ...stats, runSetCount: 20 }}
      />,
    );
    expect(screen.getByText('100,295')).toBeInTheDocument();
    expect(screen.getByText('运行记录 20 条')).toBeInTheDocument();
    expect(screen.queryByText(/内置 .* 套/)).not.toBeInTheDocument();
  });

  it('运行记录数缺失时显示 —，不编造', () => {
    wrap(
      <PostureHero
        posture={basePosture}
        postureState={ok}
        range="month"
        stats={{ ...stats, runSetCount: null }}
      />,
    );
    expect(screen.getByText(/运行记录 — 条/)).toBeInTheDocument();
  });
});

describe('TopTasks 得分容忍 null', () => {
  const task = {
    id: 't1',
    name: '终端配置体检',
    status: 'COMPLETED',
    modelName: '终端',
    createdAt: '2026-10-22T00:00:00.000Z',
    highRiskCount: 3,
    mediumRiskCount: 1,
    lowRiskCount: 0,
  };
  it('evalScore 为 null 时显示「—（评估不完整）」，不画得分条也不显示数字', () => {
    const { container } = wrap(<TopTasks tasks={[{ ...task, evalScore: null }]} state={ok} />);
    expect(screen.getByText('—（评估不完整）')).toBeInTheDocument();
    expect(container).not.toHaveTextContent('100');
    expect(container.querySelector('[style*="width"]')).toBeNull();
  });
  it('evalScore 为数字时行为不变（数字 + 得分条）', () => {
    const { container } = wrap(<TopTasks tasks={[{ ...task, evalScore: 61 }]} state={ok} />);
    expect(screen.getByText('61.0')).toBeInTheDocument();
    expect(screen.queryByText('—（评估不完整）')).not.toBeInTheDocument();
    expect(container.querySelector('[style*="width: 61%"]')).not.toBeNull();
  });
});

describe('CategoryTop 风险类别分布', () => {
  const item = (key: string, count: number) => ({
    key,
    label: `类别${key}`,
    count,
    high: 0,
    severity: {},
  });
  it('标题不再写 Top 7', () => {
    wrap(
      <CategoryTop
        data={{ total: 3, categoryCount: 1, items: [item('a', 3)] }}
        periodLabel="本月"
        state={ok}
      />,
    );
    expect(screen.getByRole('heading', { name: '风险类别分布' })).toBeInTheDocument();
    expect(screen.queryByText(/Top 7/)).not.toBeInTheDocument();
  });
  it('不足 5 行时卡片高度自适应（不拉伸占满整行），5 行及以上占满', () => {
    const { container, rerender } = wrap(
      <CategoryTop
        data={{ total: 4, categoryCount: 2, items: [item('a', 3), item('b', 1)] }}
        periodLabel="本月"
        state={ok}
      />,
    );
    const card = () => container.firstElementChild as HTMLElement;
    expect(card().className).not.toContain('h-full');
    rerender(
      <MemoryRouter>
        <CategoryTop
          data={{
            total: 15,
            categoryCount: 5,
            items: ['a', 'b', 'c', 'd', 'e'].map((k) => item(k, 3)),
          }}
          periodLabel="本月"
          state={ok}
        />
      </MemoryRouter>,
    );
    expect(card().className).toContain('h-full');
  });
});

describe('ActionList 待测试带过滤跳转', () => {
  it('「测试」按钮带 ?untested=1 跳到评估对象页', () => {
    const r = buildActions({
      highCount: 0,
      highTaskCount: 0,
      reviewCount: 0,
      remediationCount: 0,
      connectionCount: 0,
      untestedCount: 3,
      targetCount: 8,
      gateCount: 0,
      gateVisible: false,
      modelFileCount: 0,
      canDispose: true,
    });
    const item = r.items.find((i) => i.key === 'untested')!;
    expect(item.to).toBe('/model-targets?untested=1');
    expect(item.cta).toBe('测试');
  });
  it('高危行标注所选周期（随周期变化的数字要写明范围）', () => {
    const r = buildActions({
      highCount: 14,
      highTaskCount: 2,
      reviewCount: 0,
      remediationCount: 0,
      connectionCount: 0,
      untestedCount: 0,
      targetCount: 8,
      gateCount: 0,
      gateVisible: false,
      modelFileCount: 0,
      canDispose: true,
      periodLabel: '本月',
    });
    expect(r.items.find((i) => i.key === 'high')!.sub).toBe('本月 · 来自 2 个高风险任务');
  });
  it('待复核行标注统计范围', () => {
    const r = buildActions({
      highCount: 0,
      highTaskCount: 0,
      reviewCount: 133,
      remediationCount: 0,
      connectionCount: 0,
      untestedCount: 0,
      targetCount: 8,
      gateCount: 0,
      gateVisible: false,
      modelFileCount: 0,
      canDispose: true,
    });
    expect(r.items.find((i) => i.key === 'review')!.sub).toContain('全部时间');
  });
});

describe('首页断行：不出现孤字、关键数字不被截掉', () => {
  const blocks = (el: Element) =>
    [...el.children].filter((b) => b.matches('span.inline-block')).map((b) => b.textContent);

  it('按中文分句标点切块，标点留在块尾', () => {
    expect(splitClauses('存在 1 项严重风险、3 项高危风险')).toEqual([
      '存在 1 项严重风险、',
      '3 项高危风险',
    ]);
    expect(splitClauses('有效判定样本偏少，评级仅供参考')).toEqual([
      '有效判定样本偏少，',
      '评级仅供参考',
    ]);
    expect(splitClauses('尚无有效判定')).toEqual(['尚无有效判定']);
  });

  it('态势句按分句整块换行，句末不会只剩「置。」', () => {
    const { container } = render(<PostureSentence posture={basePosture} range="month" />);
    expect(blocks(container.querySelector('p')!)).toEqual([
      '本月已发起评估 9 项、',
      '完成 7 项；',
      '本月识别风险回复 22 条，',
      '其中高危 14 条需优先处置。',
    ]);
  });

  it('态势句无高危、无风险、未发起评估时同样整块换行', () => {
    const { container, rerender } = render(
      <PostureSentence
        posture={{ ...basePosture, facts: { ...basePosture.facts, highCount: 0 } }}
        range="7d"
      />,
    );
    expect(blocks(container.querySelector('p')!)).toEqual([
      '近 7 天已发起评估 9 项、',
      '完成 7 项；',
      '近 7 天识别风险回复 22 条，',
      '暂无高危风险回复。',
    ]);
    rerender(
      <PostureSentence
        posture={{
          ...basePosture,
          facts: { ...basePosture.facts, tasksInitiated: 0, findingTotal: 0 },
        }}
        range="month"
      />,
    );
    expect(blocks(container.querySelector('p')!)).toEqual([
      '本月尚未发起评估，',
      '发起评估后将在此呈现总体风险态势。',
    ]);
  });

  it('评级依据按分句换行，最后的「险」字不单独成行', () => {
    wrap(
      <PostureHero
        posture={{ ...basePosture, levelBasis: '存在 1 项严重风险、3 项高危风险', fewValid: true }}
        postureState={ok}
        range="month"
        stats={stats}
      />,
    );
    const basis = screen.getByTitle('存在 1 项严重风险、3 项高危风险');
    expect(blocks(basis)).toEqual(['存在 1 项严重风险、', '3 项高危风险']);
    const few = screen.getByText('有效判定样本偏少，').parentElement!;
    expect(blocks(few)).toEqual(['有效判定样本偏少，', '评级仅供参考']);
  });

  it('数字卡副行不截断：按「·」分段，每段内部不折行', () => {
    wrap(<PostureHero posture={basePosture} postureState={ok} range="month" stats={stats} />);
    const seg = screen.getByText('高 14 ·');
    expect(seg).toHaveClass('whitespace-nowrap');
    const sub = seg.parentElement!;
    expect(sub).not.toHaveClass('truncate');
    expect(sub).toHaveTextContent('本月 · 高 14 · 中 5 · 低 3');
    expect([...sub.children].map((c) => c.textContent)).toEqual([
      '本月 ·',
      '高 14 ·',
      '中 5 ·',
      '低 3',
    ]);
    expect(screen.getByText('接入异常 0 ·').parentElement).toHaveTextContent(
      '接入异常 0 · 待测试 4',
    );
  });
});

describe('ActionList 多列时最后一行不画分隔线', () => {
  it('5 行：单列只去最后一行；两列去第 5 行；三列去第 4、5 行', () => {
    const cls = (i: number) => rowDividerClass(i, 5).split(' ');
    expect(cls(2)).not.toContain('2xl:border-b-0');
    expect(cls(3)).toContain('2xl:border-b-0');
    expect(cls(3)).not.toContain('md:max-2xl:border-b-0');
    expect(cls(3)).not.toContain('max-md:border-b-0');
    expect(cls(4)).toEqual(
      expect.arrayContaining(['max-md:border-b-0', 'md:max-2xl:border-b-0', '2xl:border-b-0']),
    );
  });

  it('4 行：两列时第 3、4 行都是最后一行；三列时只有第 4 行', () => {
    const cls = (i: number) => rowDividerClass(i, 4).split(' ');
    expect(cls(1)).not.toContain('md:max-2xl:border-b-0');
    expect(cls(2)).toContain('md:max-2xl:border-b-0');
    expect(cls(2)).not.toContain('2xl:border-b-0');
    expect(cls(3)).toEqual(
      expect.arrayContaining(['max-md:border-b-0', 'md:max-2xl:border-b-0', '2xl:border-b-0']),
    );
  });
});
