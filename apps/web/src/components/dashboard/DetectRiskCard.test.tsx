import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { DashboardDetectRisks, RiskCount } from '@/lib/detect-risks';
import { DetectRiskCard } from './DetectRiskCard';

const SINCE = '2026-10-31T16:00:00.000Z';
const ok = { isLoading: false, isError: false };

const count = (total: number, high = 0): RiskCount => ({
  total,
  high,
  bySeverity: { CRITICAL: 0, HIGH: high, MEDIUM: total - high, LOW: 0, INFO: 0, UNRATED: 0 },
});

const data: DashboardDetectRisks = {
  period: 'month',
  periodStart: SINCE,
  truncatedCorpusScans: 0,
  discoveryRunsTruncated: false,
  categories: [
    {
      category: 'model',
      label: '模型安全',
      total: 2,
      high: 1,
      sources: [{ source: 'model_file', label: '模型文件扫描发现', count: count(2, 1) }],
    },
    {
      category: 'data',
      label: '数据安全',
      total: 3,
      high: 2,
      sources: [{ source: 'corpus', label: '语料扫描命中', count: count(3, 2) }],
    },
    {
      category: 'content',
      label: '内容安全',
      total: 12,
      high: 4,
      sources: [{ source: 'eval_content', label: '内容评估风险项', count: count(12, 4) }],
    },
    {
      category: 'app_env',
      label: '应用与环境安全',
      total: 8,
      high: 3,
      sources: [
        { source: 'eval_app', label: '智能体与终端测评风险项', count: count(4, 1) },
        { source: 'service_assurance', label: '服务核验漏洞与基线问题', count: count(2, 1) },
        { source: 'ai_component', label: '组件扫描发现', count: null },
        { source: 'asset_discovery', label: '未登记 AI 服务', count: count(2, 1) },
      ],
    },
  ],
};

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderCard(props: Partial<Parameters<typeof DetectRiskCard>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={<DetectRiskCard data={data} periodLabel="本月" state={ok} {...props} />}
        />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DetectRiskCard 四类风险（2.2.2）', () => {
  it('四格按类别显示风险数和高危数，来源列出小计', () => {
    renderCard();
    const card = screen.getByRole('region', { name: '四类风险' });
    const cells = within(card).getAllByTestId('detect-risk-cell');
    expect(cells.map((c) => c.getAttribute('data-category'))).toEqual([
      'model',
      'data',
      'content',
      'app_env',
    ]);
    const content = within(cells[2]!).getByRole('link', { name: /^内容安全/ });
    expect(content).toHaveTextContent('12');
    expect(within(content).getByText('高危 4')).toBeInTheDocument();
    expect(within(cells[3]!).getByRole('link', { name: /未登记 AI 服务/ })).toHaveTextContent('2');
  });

  it('点「数据安全」跳检测结果页，带类别和周期起点', async () => {
    renderCard();
    await userEvent.click(screen.getByRole('link', { name: /^数据安全/ }));
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/analysis/results?category=data&since=${encodeURIComponent(SINCE)}`,
    );
  });

  it('点来源跳检测结果页并带来源', async () => {
    renderCard();
    await userEvent.click(screen.getByRole('link', { name: /服务核验漏洞与基线问题/ }));
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/analysis/results?category=app_env&since=${encodeURIComponent(SINCE)}&source=service_assurance`,
    );
  });

  it('「全部」周期不带起点', async () => {
    renderCard({ data: { ...data, period: 'all', periodStart: null }, periodLabel: '全部' });
    await userEvent.click(screen.getByRole('link', { name: /^模型安全/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/analysis/results?category=model');
    expect(screen.getByTestId('location').textContent).not.toContain('since');
  });

  it('没权限的来源不显示；一个来源都看不到的类别显示「—」且不可点', () => {
    const noModel: DashboardDetectRisks = {
      ...data,
      categories: data.categories.map((c) =>
        c.category === 'model'
          ? { ...c, total: 0, high: 0, sources: c.sources.map((s) => ({ ...s, count: null })) }
          : c,
      ),
    };
    renderCard({ data: noModel });
    expect(screen.queryByText('组件扫描发现')).not.toBeInTheDocument();
    const model = screen.getAllByTestId('detect-risk-cell')[0]!;
    expect(within(model).getByText('—')).toBeInTheDocument();
    expect(within(model).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('模型文件扫描发现')).not.toBeInTheDocument();
  });

  it('有命中过多的语料扫描时，数据格提示只计已保存的部分', () => {
    renderCard({ data: { ...data, truncatedCorpusScans: 2 } });
    const cell = screen.getAllByTestId('detect-risk-cell')[1]!;
    expect(within(cell).getByText('2 次扫描命中过多，只计已保存的部分')).toBeInTheDocument();
  });

  it('资产测绘次数过多时，应用与环境格提示只计最近 500 次', () => {
    renderCard({ data: { ...data, discoveryRunsTruncated: true } });
    const cell = screen.getAllByTestId('detect-risk-cell')[3]!;
    expect(within(cell).getByText('资产测绘超过 500 次，只计最近 500 次')).toBeInTheDocument();
  });

  it('评估类比安全态势「风险回复」那一格少时，写明对比的数和原因', () => {
    renderCard({ postureFindingTotal: 17 });
    expect(
      screen.getByText('评估类比安全态势「风险回复」（已扣误报）少 1 条：终端体检通过项不计入'),
    ).toBeInTheDocument();
  });

  it('没有差额时不显示口径提示', () => {
    renderCard({ postureFindingTotal: 16 });
    expect(screen.queryByText(/终端体检通过项不计入/)).not.toBeInTheDocument();
    expect(screen.queryByText(/只计已保存的部分/)).not.toBeInTheDocument();
    expect(screen.queryByText(/只计最近 500 次/)).not.toBeInTheDocument();
  });
});
