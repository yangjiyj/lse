import { Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  buildEvaluationOutcome,
  formatEvalScore,
  formatPercent,
  taskScoreReady,
  type BadgeTone,
} from '@/lib/format';

type OutcomeInput = Parameters<typeof buildEvaluationOutcome>[0];

const OUTCOME_TONE: Record<'risk' | 'incomplete' | 'safe', BadgeTone> = {
  risk: 'danger',
  incomplete: 'warning',
  safe: 'success',
};

interface OutcomeView {
  tone: BadgeTone;
  headline: string;
  detail: string;
  /** 统计小字；「跳过引擎」为 0 时整项不出现。 */
  summary: string;
}

/**
 * 列表与详情共用的结论视图：在统一结论（buildEvaluationOutcome）之上补两处展示规则。
 * 1. 已取消的任务没有形成结论，不显示「发现 N 项风险」，而是「已取消，未形成结论（已处理 x/y）」；
 * 2. 统计行里为 0 的「跳过引擎」隐藏，避免行尾被切。
 */
export function outcomeView(task: OutcomeInput): OutcomeView {
  const outcome = buildEvaluationOutcome(task);
  const summary =
    outcome.skippedEngineCount > 0
      ? outcome.summary
      : outcome.summary.replace(/ · 跳过引擎 0$/, '');
  if (task.status === 'CANCELED') {
    const progress = `${task.processedQuestions}/${task.totalQuestions}`;
    return {
      tone: 'neutral',
      headline: `已取消，未形成结论（已处理 ${progress}）`,
      detail: `任务已被取消，仅处理 ${progress} 个样本，不形成评估结论。取消前已产生的计数保留在统计行中。`,
      summary,
    };
  }
  return {
    tone: OUTCOME_TONE[outcome.kind],
    headline: outcome.headline,
    detail: outcome.detail,
    summary,
  };
}

/** 结论主徽章：颜色 + 形状 + 文字；悬停展示完整原因。 */
export function OutcomeBadge({ task, className }: { task: OutcomeInput; className?: string }) {
  const view = outcomeView(task);
  return (
    <Badge
      tone={view.tone}
      icon
      tabIndex={0}
      className={cn('max-w-full whitespace-normal text-left', className)}
      aria-label={`${view.headline}：${view.detail}`}
      title={view.detail}
    >
      {view.headline}
    </Badge>
  );
}

/** 结论 + 次要计数小字（最多两行，悬停看全文，不再单行截断）。 */
export function OutcomeSummary({ task }: { task: OutcomeInput }) {
  const view = outcomeView(task);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <OutcomeBadge task={task} />
      <div
        className="line-clamp-2 max-w-full break-words text-xs text-ink-3 tabular-nums"
        title={view.summary}
      >
        {view.summary}
      </div>
    </div>
  );
}

export const INCOMPLETE_SCORE_TEXT = '—（评估不完整）';
const INCOMPLETE_SCORE_HINT =
  '存在未判定、异常或被跳过的样本，评估不完整时不给出得分，避免被误读为安全。';

export type EvalScoreView =
  | { kind: 'none' }
  | { kind: 'incomplete' }
  | { kind: 'score'; value: number | null };

/**
 * 评估得分的展示决策（列表单元格与详情徽标共用）：
 * - 任务还没有可出分的结果（排队中、运行中、失败、取消、已处理 0）：不出分，不贴「评估不完整」；
 * - 已完成但评估不完整（与结论文案同一个 buildEvaluationOutcome 谓词）：显示「—（评估不完整）」，
 *   即使收到旧的数字也不显示，防止前后端版本错位时把半截结果显示成满分；
 * - 其余按后端 evalScore 显示。
 */
export function evalScoreView(task: OutcomeInput & { evalScore?: number | null }): EvalScoreView {
  if (!taskScoreReady(task)) return { kind: 'none' };
  if (buildEvaluationOutcome(task).incomplete) return { kind: 'incomplete' };
  return { kind: 'score', value: task.evalScore ?? null };
}

/** 任务列表「评估得分」列单元格。 */
export function TaskScoreCell({ task }: { task: OutcomeInput & { evalScore?: number | null } }) {
  const view = evalScoreView(task);
  if (view.kind === 'incomplete')
    return (
      <span
        className="block whitespace-normal text-xs font-medium leading-4 text-ink-3"
        title={INCOMPLETE_SCORE_HINT}
      >
        {INCOMPLETE_SCORE_TEXT}
      </span>
    );
  return <span>{formatEvalScore(view.kind === 'score' ? view.value : null)}</span>;
}

const STATUS_NOTE_MAX_CHARS = 120;

/**
 * 终端测评任务的状态副文（审批/执行/驳回原因）。
 * 最多两行，完整内容放 title 悬停；被切掉的恰恰是原因，所以不再单行省略。
 * 历史任务的 description 可能是几千字的原始日志，这里先压成一行并限长。
 */
export function TaskStatusNote({
  targetType,
  description,
}: {
  targetType?: string;
  description?: string | null;
}) {
  if (targetType !== 'ENDPOINT_AGENT' || !description) return null;
  const oneLine = description.replace(/\s+/g, ' ').trim();
  const short =
    oneLine.length > STATUS_NOTE_MAX_CHARS
      ? `${oneLine.slice(0, STATUS_NOTE_MAX_CHARS)}…`
      : oneLine;
  return (
    <span
      className="mt-1 line-clamp-2 block max-w-full break-words text-xs leading-4 text-muted-foreground"
      title={description.length > 2000 ? `${description.slice(0, 2000)}…` : description}
    >
      {short}
    </span>
  );
}

const BAR_TONE: Record<string, string> = {
  COMPLETED: 'bg-severity-pass',
  FAILED: 'bg-severity-critical',
  CANCELED: 'bg-slate-400',
};

/** 细进度条 + 「已处理/总数」。 */
export function TaskProgress({
  processed,
  total,
  status,
}: {
  processed: number;
  total: number;
  status: string;
}) {
  const ratio = total ? Math.min(processed / total, 1) : 0;
  return (
    <div className="w-full min-w-[84px]">
      <div className="flex items-baseline justify-between gap-2 text-[13px] tabular-nums text-ink">
        <span>
          {processed}/{total}
        </span>
        <span className="text-xs text-ink-3">({formatPercent(ratio, 0)})</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        aria-label="执行进度"
        className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line"
      >
        <div
          className={cn(
            'h-full rounded-full transition-all',
            BAR_TONE[status] ?? 'bg-brand-600',
            status === 'RUNNING' && 'animate-pulse',
          )}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** 统一的日期范围筛选：一个胶囊内「开始日期 — 结束日期」，保留两个原生日期输入的可访问名称。 */
export function DateRangeFilter({
  from,
  to,
  onFrom,
  onTo,
  fromLabel,
  toLabel,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  fromLabel: string;
  toLabel: string;
}) {
  const cls =
    'h-full w-[118px] bg-transparent px-1 text-[13px] text-ink outline-none [color-scheme:light] focus-visible:text-brand-700 [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100';
  return (
    <div className="flex h-10 items-center gap-1 rounded-[10px] border border-line-2 bg-white px-2.5 transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 hover:border-brand-400/70">
      <span className="mr-1 text-[13px] text-ink-3">执行时间</span>
      <input
        type="date"
        aria-label={fromLabel}
        value={from}
        max={to || undefined}
        onChange={(e) => onFrom(e.target.value)}
        className={cls}
      />
      <span className="text-ink-3">—</span>
      <input
        type="date"
        aria-label={toLabel}
        value={to}
        min={from || undefined}
        onChange={(e) => onTo(e.target.value)}
        className={cls}
      />
    </div>
  );
}

/** 弹窗内的说明条：统一的信息提示样式。 */
export function ModalNotice({
  children,
  detail,
}: {
  children: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-brand-100 bg-brand-50/70 px-3.5 py-3 text-sm leading-6 text-ink-2">
      <Info className="mt-1 h-4 w-4 shrink-0 text-brand-600" aria-hidden="true" />
      <div className="space-y-0.5">
        <p>{children}</p>
        {detail && <p className="text-xs leading-5 text-ink-3">{detail}</p>}
      </div>
    </div>
  );
}
