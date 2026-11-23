import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Box, Database, Layers, TriangleAlert, Wrench } from 'lucide-react';
import type {
  DashboardChanges,
  DashboardPosture,
  DashboardRange,
  PostureRiskLevel,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { CardError, CardSkeleton, type CardLoadState } from './DashCard';
import { fmt, rangeLabel } from './utils';

const LEVEL_TONE: Record<PostureRiskLevel, BadgeTone> = {
  HIGH: 'danger',
  MEDIUM_HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'success',
  UNRATED: 'neutral',
};
const LEVEL_COLOR: Record<PostureRiskLevel, string> = {
  HIGH: '#B04A05',
  MEDIUM_HIGH: '#B04A05',
  MEDIUM: '#D9A406',
  LOW: '#1B7A46',
  UNRATED: '#A8B3C2',
};

/** 评分环：仅在有分数时绘制；纯 SVG。 */
export function ScoreRing({ score, level }: { score: number; level: PostureRiskLevel }) {
  const r = 58;
  const c = 2 * Math.PI * r;
  const ratio = Math.max(0, Math.min(100, score)) / 100;
  return (
    <div
      className="relative h-[140px] w-[140px] shrink-0"
      role="img"
      aria-label={`综合评分 ${score} 分`}
      data-testid="score-ring"
    >
      <svg viewBox="0 0 140 140" className="h-full w-full -rotate-90">
        <defs>
          <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={LEVEL_COLOR[level]} />
            <stop offset="100%" stopColor="#F29A4B" stopOpacity={level === 'LOW' ? 0 : 1} />
          </linearGradient>
        </defs>
        <circle cx="70" cy="70" r={r} fill="none" stroke="#EAF0F6" strokeWidth="13" />
        <circle
          cx="70"
          cy="70"
          r={r}
          fill="none"
          stroke={level === 'LOW' ? LEVEL_COLOR[level] : 'url(#ring-grad)'}
          strokeWidth="13"
          strokeLinecap="round"
          strokeDasharray={`${c * ratio} ${c}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-num text-[40px] font-bold leading-none tabular-nums text-ink">
          {Number.isInteger(score) ? score : score.toFixed(1)}
        </span>
        <span className="mt-1 text-xs text-ink-3">综合评分</span>
      </div>
    </div>
  );
}

function Num({ children, tone }: { children: ReactNode; tone?: 'danger' }) {
  return (
    <b
      className={`font-num font-bold tabular-nums ${tone === 'danger' ? 'text-severity-critical' : 'text-brand-600'}`}
    >
      {children}
    </b>
  );
}

/** 按中文分句标点切块（标点留在块尾），供整块换行用。 */
export function splitClauses(text: string): string[] {
  return text.match(/[^、，；。：]+[、，；。：]*/g) ?? [text];
}

/**
 * 一个分句：行宽不够时整块换到下一行，比一行还宽时才在块内折行。
 * 中文逐字都能断行，不分块的话句末常常只剩「置。」「险」这样一两个字。
 */
function Clause({ children }: { children: ReactNode }) {
  return <span className="inline-block">{children}</span>;
}

function ClauseText({ text }: { text: string }) {
  return (
    <>
      {splitClauses(text).map((c, i) => (
        <Clause key={i}>{c}</Clause>
      ))}
    </>
  );
}

/** 一句话态势：全部由 facts 生成。 */
export function PostureSentence({
  posture,
  range,
}: {
  posture: DashboardPosture;
  range: DashboardRange;
}) {
  const { facts } = posture;
  // 句子里所有数字都是「所选周期」内的数，统一用周期前缀；全部范围才用「累计」。
  const prefix = range === 'all' ? '累计' : rangeLabel(range);
  if (facts.tasksInitiated === 0 && facts.findingTotal === 0) {
    return (
      <p className="text-[20px] font-semibold leading-8 text-ink">
        <Clause>{range === 'all' ? '尚未发起评估' : `${rangeLabel(range)}尚未发起评估`}，</Clause>
        <Clause>发起评估后将在此呈现总体风险态势。</Clause>
      </p>
    );
  }
  return (
    <p className="text-balance text-[20px] font-semibold leading-8 text-ink">
      <Clause>
        {prefix}已发起评估 <Num>{fmt(facts.tasksInitiated)}</Num> 项、
      </Clause>
      <Clause>
        完成 <Num>{fmt(facts.tasksCompleted)}</Num> 项；
      </Clause>
      {facts.findingTotal > 0 ? (
        <>
          <Clause>
            {prefix}识别风险回复 <Num>{fmt(facts.findingTotal)}</Num> 条，
          </Clause>
          {facts.highCount > 0 ? (
            <Clause>
              其中高危 <Num tone="danger">{fmt(facts.highCount)}</Num> 条需优先处置。
            </Clause>
          ) : (
            <Clause>暂无高危风险回复。</Clause>
          )}
        </>
      ) : (
        <Clause>暂未识别到风险回复。</Clause>
      )}
      {facts.falsePositiveExcluded > 0 && (
        <span className="ml-1 inline-block text-[13px] font-normal text-ink-3">
          （已排除 {fmt(facts.falsePositiveExcluded)} 条误报）
        </span>
      )}
    </p>
  );
}

function StatTile({
  icon,
  label,
  value,
  sub,
  to,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  /** 副行各段；段与段之间用「·」隔开，行宽不够时整段换行，不截断数字。 */
  sub: string[];
  /** 下钻到的列表页；不传则不可点。 */
  to?: string;
}) {
  const box = 'min-w-0 rounded-xl border border-line bg-white/80 px-3.5 py-3';
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
        {icon}
        <span>{label}</span>
      </div>
      <div className="font-num mt-1 text-[24px] font-bold leading-8 tabular-nums text-ink">
        {value}
      </div>
      <div className="mt-0.5 text-balance text-xs leading-[18px] text-ink-3">
        {sub.map((s, i) => (
          <Fragment key={i}>
            {i > 0 && ' '}
            <span className="whitespace-nowrap">{i < sub.length - 1 ? `${s} ·` : s}</span>
          </Fragment>
        ))}
      </div>
    </>
  );
  return to ? (
    <Link to={to} className={`${box} block hover:border-brand-400`}>
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  );
}

/** 统计数字下钻到的列表页（2.2.4）；没有对应页面权限的不传。 */
export interface HeroLinks {
  tasks?: string;
  findings?: string;
  targets?: string;
  samples?: string;
  tools?: string;
}

export interface HeroStats {
  taskTotal: number | null;
  periodTaskCount: number | null;
  completedCount: number | null;
  findingTotal: number | null;
  severity: { high: number; medium: number; low: number } | null;
  targetCount: number | null;
  connectionIssues: number | null;
  untested: number | null;
  /** 样本题数：与「规则库 · 题目」同口径（在用的内置题 + 自有样本题）。 */
  sampleTotal: number | null;
  /** 运行记录条数（评估任务自动落库的快照），不算自有样本库。 */
  runSetCount?: number | null;
  /** 工具中心里当前用户可见的工具数；没有工具中心权限时为 null，不显示。 */
  toolCount?: number | null;
}

function Dash() {
  return <span className="text-ink-3">—</span>;
}

/** 变化的对比基准（灰字）：变化数字都是本期与上一等长周期相比。 */
const COMPARE_BASELINE: Record<DashboardRange, string> = {
  month: '对比上月同期',
  '7d': '对比前 7 天',
  all: '',
};

/** 本期变化标签：接口返回 null 的指标一律不显示。 */
export function ChangeTags({
  changes,
  range,
}: {
  changes: DashboardChanges;
  range: DashboardRange;
}) {
  const tags: ReactNode[] = [];
  // 增加=风险上升（橙），下降=好转（绿）
  const arrow = (delta: number, text: string, key: string, title: string) => (
    <span
      key={key}
      title={title}
      className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-2.5 py-1 text-[12.5px] text-ink-2"
    >
      {text.split('|')[0]}
      <b
        className={`inline-flex items-center gap-0.5 font-num tabular-nums ${delta > 0 ? 'text-severity-high' : delta < 0 ? 'text-severity-pass' : 'text-ink-3'}`}
      >
        {text.split('|')[1]}
        {delta > 0 ? (
          <ArrowUp className="h-3 w-3" aria-hidden="true" />
        ) : delta < 0 ? (
          <ArrowDown className="h-3 w-3" aria-hidden="true" />
        ) : null}
      </b>
    </span>
  );
  const nf = changes.newFindings;
  if (nf && nf.delta != null) {
    tags.push(
      arrow(
        nf.delta,
        `新增风险回复 |${nf.delta > 0 ? '+' : ''}${nf.delta}`,
        'new',
        `本期 ${nf.current ?? '—'} 条，上期 ${nf.previous ?? '—'} 条`,
      ),
    );
  }
  const hs = changes.highShare;
  if (hs && hs.current != null && hs.delta != null) {
    const pts = hs.delta * 100;
    tags.push(
      arrow(
        pts,
        `高危占比 ${(hs.current * 100).toFixed(1)}% |${pts > 0 ? '+' : ''}${pts.toFixed(1)} 个百分点`,
        'share',
        hs.previous != null ? `上期 ${(hs.previous * 100).toFixed(1)}%` : '',
      ),
    );
  } else if (hs && hs.current != null) {
    // 有当前值但无环比：仅展示当前值，不编造变化方向
    tags.push(
      <span
        key="share"
        className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-2.5 py-1 text-[12.5px] text-ink-2"
      >
        高危占比 <b className="font-num tabular-nums text-ink">{(hs.current * 100).toFixed(1)}%</b>
      </span>,
    );
  }
  const rv = changes.avgReviewHours;
  if (rv && rv.current != null) {
    const d = rv.previous != null ? rv.current - rv.previous : null;
    tags.push(
      <span
        key="review"
        title={rv.previous != null ? `上期 ${rv.previous.toFixed(1)} 小时` : undefined}
        className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-2.5 py-1 text-[12.5px] text-ink-2"
      >
        平均复核时长 <b className="font-num tabular-nums text-ink">{rv.current.toFixed(1)} 小时</b>
        {d != null && d !== 0 && (
          <b
            className={`inline-flex items-center font-num tabular-nums ${d > 0 ? 'text-severity-high' : 'text-severity-pass'}`}
          >
            {d > 0 ? (
              <ArrowUp className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ArrowDown className="h-3 w-3" aria-hidden="true" />
            )}
          </b>
        )}
      </span>,
    );
  }
  if (tags.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" aria-label={`${rangeLabel(range)}变化`}>
      <span className="text-[12.5px] text-ink-3">{rangeLabel(range)}变化</span>
      <span className="text-[12px] text-ink-3/80" data-testid="change-baseline">
        {COMPARE_BASELINE[range]}
      </span>
      {tags}
    </div>
  );
}

export function PostureHero({
  posture,
  postureState,
  changes,
  range,
  stats,
  links = {},
}: {
  posture?: DashboardPosture;
  postureState: CardLoadState;
  changes?: DashboardChanges;
  range: DashboardRange;
  stats: HeroStats;
  links?: HeroLinks;
}) {
  const st = stats;
  return (
    <Card
      aria-label="总体风险态势"
      className="relative overflow-hidden bg-gradient-to-br from-white via-white to-brand-50/70 p-6"
    >
      {postureState.isError ? (
        <CardError onRetry={postureState.onRetry} name="总体风险态势" />
      ) : postureState.isLoading || !posture ? (
        <CardSkeleton rows={5} className="py-6" />
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="flex shrink-0 flex-col items-center gap-3 lg:w-[176px]">
            {posture.score != null ? (
              <ScoreRing score={posture.score} level={posture.riskLevel} />
            ) : (
              <div className="grid h-[140px] w-[140px] place-items-center rounded-full border-2 border-dashed border-line-2 text-center text-xs text-ink-3">
                暂无综合评分
              </div>
            )}
            <Badge
              tone={LEVEL_TONE[posture.riskLevel]}
              icon
              className="px-3 py-1 text-[14px]"
              data-testid="level-badge"
            >
              {posture.riskLevel === 'UNRATED'
                ? '暂无法评级'
                : `总体风险：${posture.riskLevelLabel}`}
            </Badge>
            {posture.levelBasis && (
              <p
                className="line-clamp-2 max-w-[180px] text-center text-xs leading-[18px] text-ink-3"
                title={posture.levelBasis}
              >
                <ClauseText text={posture.levelBasis} />
              </p>
            )}
            {posture.fewValid && (
              <p className="max-w-[180px] text-center text-xs leading-[18px] text-severity-high">
                <ClauseText text="有效判定样本偏少，评级仅供参考" />
              </p>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <PostureSentence posture={posture} range={range} />
            <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(138px,1fr))] gap-3">
              <StatTile
                icon={<Layers className="h-3.5 w-3.5" aria-hidden="true" />}
                label="评估任务"
                to={links.tasks}
                value={st.taskTotal != null ? fmt(st.taskTotal) : <Dash />}
                sub={
                  st.periodTaskCount != null
                    ? [
                        `${rangeLabel(range)} ${st.periodTaskCount}`,
                        `已完成 ${st.completedCount ?? 0}`,
                      ]
                    : []
                }
              />
              <StatTile
                icon={<TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />}
                label="风险回复"
                to={links.findings}
                value={st.findingTotal != null ? fmt(st.findingTotal) : <Dash />}
                sub={
                  st.severity
                    ? [
                        rangeLabel(range),
                        `高 ${st.severity.high}`,
                        `中 ${st.severity.medium}`,
                        `低 ${st.severity.low}`,
                      ]
                    : []
                }
              />
              <StatTile
                icon={<Box className="h-3.5 w-3.5" aria-hidden="true" />}
                label="评估对象"
                to={links.targets}
                value={st.targetCount != null ? fmt(st.targetCount) : <Dash />}
                sub={
                  st.targetCount != null
                    ? [`接入异常 ${st.connectionIssues ?? '—'}`, `待测试 ${st.untested ?? '—'}`]
                    : []
                }
              />
              <StatTile
                icon={<Database className="h-3.5 w-3.5" aria-hidden="true" />}
                label="样本资产"
                to={links.samples}
                value={st.sampleTotal != null ? fmt(st.sampleTotal) : <Dash />}
                // 大数字与「规则库 · 题目」同口径；题集套数规则库卡已有，这里只补规则库不算的运行记录。
                sub={st.sampleTotal != null ? [`运行记录 ${st.runSetCount ?? '—'} 条`] : []}
              />
              {st.toolCount != null && (
                <StatTile
                  icon={<Wrench className="h-3.5 w-3.5" aria-hidden="true" />}
                  label="工具"
                  to={links.tools}
                  value={fmt(st.toolCount)}
                  sub={[]}
                />
              )}
            </div>
            {changes && <ChangeTags changes={changes} range={range} />}
          </div>
        </div>
      )}
    </Card>
  );
}
