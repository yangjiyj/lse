import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { ArrowLeft } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type EvalCompareItem } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { TaskStatusBadge } from '@/components/ui/status-badge';
import { QueryState } from '@/components/QueryState';
import {
  formatPercent,
  formatDateTime,
  EVAL_SCORE_HINT,
  formatEvalScore,
  AGENT_RISK_SURFACE_LABELS,
  riskCategoryLabel,
} from '@/lib/format';
import { normalizeCategoryName } from '@lse/shared';
import { CHART_GRID, CHART_TEXT, TOOLTIP_STYLE } from './dashboard/charts';
import { differenceTone, formatFailRateWithInterval } from '@/components/EvalCredibility';
import { PlanRunPicker, type PlanRunSelection } from './eval-plans/PlanRunPicker';
import { RegressionView } from './eval-plans/RegressionView';

const AXIS_TICK = { fill: CHART_TEXT, fontSize: 12 };
const LEGEND_STYLE = { color: CHART_TEXT, fontSize: 12 };
// 对比图配色取自设计令牌：主蓝系用于模型/得分，严重度色用于风险等级。
const SCORE_COLORS = ['#1F57E0', '#7FA6F5'];
const MODEL_COLORS = ['#1F57E0', '#B04A05', '#1B7A46', '#8A5F00', '#4F6B8A'];
const RISK_BAR_COLORS = { HIGH: '#B04A05', MEDIUM: '#D9A400', LOW: '#9BB0C7' };

/** 雷达图类别过多时轴标签会互相重叠，超过该数量不画雷达图（表格与条形图仍完整）。 */
export const RADAR_MAX_CATEGORIES = 12;
/** 条形图最多展示的类别数（按两个任务通过率差异最大的前 N 个）。 */
const CATEGORY_BAR_LIMIT = 10;

/**
 * 类别展示名：agent:xxx 译成中文；英文类别名（生成器英文模板产出）归一到中文风险域，
 * 这样「提示注入」与「Prompt Injection」会合并成同一行。
 */
export function categoryLabel(category: string): string {
  if (category.startsWith('agent:')) {
    const key = category.slice(6);
    return AGENT_RISK_SURFACE_LABELS[key] ?? riskCategoryLabel(key);
  }
  const normalized = normalizeCategoryName(category);
  if (normalized !== category) return normalized;
  // 英文类别码（如 prompt_injection）也走统一风险类别中文映射；已是中文的原样保留。
  return /[一-鿿]/.test(category) ? category : riskCategoryLabel(category);
}

type CategoryStat = EvalCompareItem['categories'][number];

/** 把同一任务里归一后同名的类别合并：通过数、不通过数相加后重算通过率。 */
function mergeCategories(categories: CategoryStat[]): Map<string, CategoryStat> {
  const merged = new Map<string, CategoryStat>();
  for (const c of categories) {
    const name = categoryLabel(c.category);
    const prev = merged.get(name);
    const passed = (prev?.passed ?? 0) + c.passed;
    const failed = (prev?.failed ?? 0) + c.failed;
    merged.set(name, {
      category: name,
      passed,
      failed,
      passRate: passed + failed > 0 ? passed / (passed + failed) : null,
    });
  }
  return merged;
}

/**
 * 图例/表头/图表系列名：同一模型出现在多个任务里（模型名相同）时加「任务 A / B」区分，
 * 接口返回创建时间时一并附上，避免图例里两个系列同名无法区分。
 */
export function taskSeriesLabel(
  item: EvalCompareItem,
  index: number,
  all: EvalCompareItem[],
): string {
  const duplicated = all.filter((x) => x.modelName === item.modelName).length > 1;
  if (!duplicated) return item.modelName;
  const letter = String.fromCharCode(65 + (index % 26));
  const createdAt = (item as { createdAt?: string }).createdAt;
  return `${item.modelName} · 任务 ${letter}${createdAt ? `（${formatDateTime(createdAt)}）` : ''}`;
}

function pct(v: number | null): string {
  return v == null ? '—' : formatPercent(v, 1);
}

/** 分类别通过率矩阵：行=类别，列=各模型（百分数）。 */
export function categoryMatrix(items: EvalCompareItem[]) {
  const perTask = new Map(items.map((i) => [i.id, mergeCategories(i.categories)]));
  const names = [...new Set([...perTask.values()].flatMap((m) => [...m.keys()]))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
  return names.map((category) => {
    const row: Record<string, string | number | null> = { category };
    for (const item of items) {
      const hit = perTask.get(item.id)?.get(category);
      row[item.id] = hit?.passRate == null ? null : Math.round(hit.passRate * 1000) / 10;
    }
    return row;
  });
}

/** 条形图用：类别过多时取各任务通过率差异最大的前 N 个类别。 */
export function topCategoryRows(
  matrix: ReturnType<typeof categoryMatrix>,
  items: EvalCompareItem[],
  limit = CATEGORY_BAR_LIMIT,
) {
  const spread = (row: Record<string, string | number | null>) => {
    const values = items.map((i) => row[i.id]).filter((v): v is number => typeof v === 'number');
    return values.length < 2 ? 0 : Math.max(...values) - Math.min(...values);
  };
  return [...matrix].sort((a, b) => spread(b) - spread(a)).slice(0, limit);
}

/** 回归对比模式：计划相邻运行（planId[+headTaskId][+baseTaskId]）或任选两任务（baseTaskId+headTaskId）。 */
function regressionSelection(params: URLSearchParams): PlanRunSelection | null {
  const sel: PlanRunSelection = {
    planId: params.get('planId') ?? undefined,
    baseTaskId: params.get('baseTaskId') ?? undefined,
    headTaskId: params.get('headTaskId') ?? undefined,
  };
  if (sel.planId || (sel.baseTaskId && sel.headTaskId)) return sel;
  return null;
}

function RegressionSection({ selection }: { selection: PlanRunSelection }) {
  const [, setParams] = useSearchParams();
  const query = useQuery({
    queryKey: ['eval-regression', selection.planId, selection.baseTaskId, selection.headTaskId],
    queryFn: () => api.evalPlans.regression(selection),
    retry: false,
  });
  const onPick = (next: PlanRunSelection) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    setParams(q);
  };
  // 不足两次运行等业务提示（400）直接展示原因，其他错误走统一重试。
  const businessError =
    query.error instanceof ApiError && query.error.status === 400 ? query.error.message : null;
  return (
    <>
      {selection.planId && <PlanRunPicker value={selection} onChange={onPick} />}
      {businessError ? (
        <Card>
          <CardContent className="p-6 text-sm text-severity-high">{businessError}</CardContent>
        </Card>
      ) : (
        <QueryState
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          onRetry={() => void query.refetch()}
          empty={false}
          emptyTitle=""
          emptyDescription=""
        />
      )}
      {query.data ? <RegressionView data={query.data} /> : null}
    </>
  );
}

export function EvalComparePage() {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const ids = params.get('ids') ?? undefined;
  const batchId = params.get('batchId') ?? undefined;
  const regression = regressionSelection(params);
  const canRead = hasPermission('eval_task:read');
  const idList = ids ? ids.split(',').filter(Boolean) : [];
  const query = useQuery({
    queryKey: ['eval-compare', ids, batchId],
    queryFn: () => api.evalTasks.compare({ ids, batchId }),
    enabled: canRead && !regression && Boolean(ids || batchId),
    refetchInterval: (q) =>
      q.state.data?.items.some((i) => i.status === 'PENDING' || i.status === 'RUNNING')
        ? 5000
        : false,
  });
  const items = query.data?.items ?? [];
  const matrix = categoryMatrix(items);
  const seriesNames = items.map((item, idx) => taskSeriesLabel(item, idx, items));
  const seriesName = (id: string) => seriesNames[items.findIndex((x) => x.id === id)] ?? id;
  const showRadar = matrix.length <= RADAR_MAX_CATEGORIES;
  const barRows = topCategoryRows(matrix, items);
  const scoreData = items.map((i, idx) => ({
    name: seriesNames[idx] ?? i.modelName,
    评估得分: i.evalScore ?? 0,
    通过率: i.passRate == null ? 0 : Math.round(i.passRate * 1000) / 10,
    高风险: i.riskLevels.HIGH,
    中风险: i.riskLevels.MEDIUM,
    低风险: i.riskLevels.LOW,
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        title={regression ? '回归对比' : '任务对比'}
        description={
          regression
            ? '按题目对齐两次运行，查看新增失败、已修复、仍失败、分数与各类别变化'
            : '同一样本集下多个任务（模型）的得分、通过率与风险对比'
        }
        actions={
          <Link
            to="/eval-tasks"
            className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-line-2 bg-white px-4 text-[13.5px] font-medium text-ink transition-colors hover:border-brand-400 hover:text-brand-700"
          >
            <ArrowLeft className="h-4 w-4" />
            返回任务列表
          </Link>
        }
      />
      {canRead && regression ? <RegressionSection selection={regression} /> : null}
      {canRead && !regression && !ids && !batchId ? (
        <PlanRunPicker
          value={{}}
          onChange={(next) => {
            if (next.planId) setParams({ planId: next.planId });
          }}
        />
      ) : null}
      {(!regression || !canRead) && (
        <QueryState
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          onRetry={() => void query.refetch()}
          empty={!ids && !batchId}
          permissionDenied={!canRead}
          emptyTitle="未选择对比任务"
          emptyDescription="请在任务列表勾选至少 2 个任务后点击“对比分析”，或在上方按计划选择运行做回归对比。"
        />
      )}
      {!regression && items.length > 0 ? (
        <>
          <Card>
            <CardContent className="p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-[15px] font-bold text-ink">对比概览</h2>
                {items.length === 2 && idList.length === 2 ? (
                  <div className="flex items-center gap-2 text-xs text-ink-3">
                    <span>以较早创建的任务为基线</span>
                    <Link
                      to={`/eval-tasks/compare?baseTaskId=${encodeURIComponent(items[0]!.id)}&headTaskId=${encodeURIComponent(items[1]!.id)}`}
                      className="inline-flex h-8 items-center rounded-[9px] bg-brand-50 px-3 text-[13px] font-medium text-brand-700 hover:bg-brand-100"
                    >
                      按题目回归对比这两个任务
                    </Link>
                  </div>
                ) : null}
              </div>
              <Table aria-label="任务对比">
                <THead>
                  <TR>
                    <TH>评估对象</TH>
                    <TH>任务</TH>
                    <TH>状态</TH>
                    <TH title={EVAL_SCORE_HINT}>评估得分</TH>
                    <TH>通过率</TH>
                    <TH>失败率（置信区间）</TH>
                    <TH>高风险</TH>
                    <TH>中风险</TH>
                    <TH>低风险</TH>
                  </TR>
                </THead>
                <TBody>
                  {items.map((i, idx) => (
                    <TR key={i.id}>
                      <TD data-label="评估对象" className="font-medium">
                        {seriesNames[idx] ?? i.modelName}
                      </TD>
                      <TD data-label="任务">
                        <Link to={`/eval-tasks/${i.id}`} className="text-primary hover:underline">
                          {i.name}
                        </Link>
                      </TD>
                      <TD data-label="状态">
                        <TaskStatusBadge value={i.status} />
                      </TD>
                      <TD data-label="评估得分" className="font-semibold tabular-nums">
                        {formatEvalScore(i.evalScore)}
                      </TD>
                      <TD data-label="通过率" className="tabular-nums">
                        {pct(i.passRate)}
                      </TD>
                      <TD data-label="失败率（置信区间）" className="tabular-nums">
                        {formatFailRateWithInterval(i.statistics)}
                        {i.statistics ? (
                          <span className="ml-1 text-xs text-slate-500">
                            n={i.statistics.sampleSize}
                          </span>
                        ) : null}
                      </TD>
                      <TD data-label="高风险" className="tabular-nums">
                        {i.riskLevels.HIGH}
                      </TD>
                      <TD data-label="中风险" className="tabular-nums">
                        {i.riskLevels.MEDIUM}
                      </TD>
                      <TD data-label="低风险" className="tabular-nums">
                        {i.riskLevels.LOW}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {(query.data?.differences ?? []).length > 0 ? (
                <ul
                  aria-label="失败率差异可信度"
                  className="mt-4 space-y-2 rounded-xl bg-[#F7F9FD] px-4 py-3 text-[13.5px] leading-6 text-ink-2"
                >
                  {(query.data?.differences ?? []).map((diff) => {
                    const tone = differenceTone(diff);
                    return (
                      <li key={diff.taskId}>
                        {seriesName(diff.taskId)} 相对 {seriesName(diff.baselineTaskId)}：失败率
                        {diff.delta === null
                          ? ' —'
                          : `${diff.delta > 0 ? '上升' : diff.delta < 0 ? '下降' : '持平'} ${Math.abs(diff.delta * 100).toFixed(1)} 个百分点`}
                        ，<span className={tone.className}>{tone.text}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              <p className="mt-3 text-xs leading-5 text-ink-3">
                失败率的置信区间表示：当前样本量下真实失败率有 95%
                的把握落在该范围；两个区间重叠时， 差异可能只是随机波动，不宜直接下结论。
              </p>
            </CardContent>
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card>
              <CardContent className="p-6">
                <h2 className="mb-4 text-[15px] font-bold text-ink">评估得分与通过率（%）</h2>
                <div role="img" aria-label="评估得分与通过率对比柱状图" className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={scoreData}>
                      <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={AXIS_TICK} interval={0} />
                      <YAxis domain={[0, 100]} tick={AXIS_TICK} />
                      <Tooltip {...TOOLTIP_STYLE} />
                      <Legend wrapperStyle={LEGEND_STYLE} />
                      <Bar dataKey="评估得分" fill={SCORE_COLORS[0]} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="通过率" fill={SCORE_COLORS[1]} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <h2 className="mb-4 text-[15px] font-bold text-ink">高、中、低风险数量</h2>
                <div role="img" aria-label="高中低风险数量对比柱状图" className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={scoreData}>
                      <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={AXIS_TICK} interval={0} />
                      <YAxis allowDecimals={false} tick={AXIS_TICK} />
                      <Tooltip {...TOOLTIP_STYLE} />
                      <Legend wrapperStyle={LEGEND_STYLE} />
                      <Bar dataKey="高风险" stackId="r" fill={RISK_BAR_COLORS.HIGH} />
                      <Bar dataKey="中风险" stackId="r" fill={RISK_BAR_COLORS.MEDIUM} />
                      <Bar dataKey="低风险" stackId="r" fill={RISK_BAR_COLORS.LOW} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="p-6">
              <h2 className="mb-4 text-[15px] font-bold text-ink">分类别通过率</h2>
              {matrix.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  暂无已判定的分类结果，任务完成后自动展示。
                </p>
              ) : (
                <div className="grid gap-5 xl:grid-cols-2">
                  {/* min-w-0：grid 子项默认 min-width:auto，表格会撑破列宽把第二个任务的列挤出视口；
                      这里让容器自己横向滚动。 */}
                  <div className="min-w-0 overflow-x-auto">
                    <Table aria-label="分类别通过率">
                      <THead>
                        <TR>
                          <TH>类别</TH>
                          {items.map((i, idx) => (
                            <TH key={i.id} className="whitespace-normal">
                              {seriesNames[idx] ?? i.modelName}
                            </TH>
                          ))}
                        </TR>
                      </THead>
                      <TBody>
                        {matrix.map((row) => (
                          <TR key={String(row.category)}>
                            <TD data-label="类别" title={String(row.category)}>
                              {String(row.category)}
                            </TD>
                            {items.map((i, idx) => (
                              <TD
                                key={i.id}
                                data-label={seriesNames[idx] ?? i.modelName}
                                className="tabular-nums"
                              >
                                {row[i.id] == null ? '—' : `${row[i.id]}%`}
                              </TD>
                            ))}
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </div>
                  {showRadar ? (
                    <div role="img" aria-label="分类别通过率雷达图" className="h-72 min-w-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <RadarChart data={matrix}>
                          <PolarGrid stroke={CHART_GRID} />
                          <PolarAngleAxis dataKey="category" tick={AXIS_TICK} />
                          <PolarRadiusAxis domain={[0, 100]} tick={AXIS_TICK} />
                          <Tooltip {...TOOLTIP_STYLE} />
                          <Legend wrapperStyle={LEGEND_STYLE} />
                          {items.map((i, idx) => (
                            <Radar
                              key={i.id}
                              name={seriesNames[idx] ?? i.modelName}
                              dataKey={i.id}
                              stroke={MODEL_COLORS[idx % MODEL_COLORS.length]}
                              fill={MODEL_COLORS[idx % MODEL_COLORS.length]}
                              fillOpacity={0.15}
                            />
                          ))}
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div
                      role="img"
                      aria-label="分类别通过率条形图"
                      className="min-w-0"
                      style={{ height: Math.max(288, barRows.length * 34 + 56) }}
                    >
                      <p className="mb-1 text-xs text-ink-3">
                        类别较多（{matrix.length} 个），仅展示各任务通过率差异最大的前{' '}
                        {barRows.length} 个类别；完整数据见左侧表格。
                      </p>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={barRows} layout="vertical" margin={{ left: 24 }}>
                          <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" />
                          <XAxis type="number" domain={[0, 100]} tick={AXIS_TICK} />
                          <YAxis
                            type="category"
                            dataKey="category"
                            width={110}
                            tick={AXIS_TICK}
                            interval={0}
                          />
                          <Tooltip {...TOOLTIP_STYLE} />
                          <Legend wrapperStyle={LEGEND_STYLE} />
                          {items.map((i, idx) => (
                            <Bar
                              key={i.id}
                              name={seriesNames[idx] ?? i.modelName}
                              dataKey={i.id}
                              fill={MODEL_COLORS[idx % MODEL_COLORS.length]}
                            />
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
