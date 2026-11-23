import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TaskStatusBadge } from '@/components/ui/status-badge';
import type { EvalTaskDetail } from '@/lib/api';
import {
  ENGINE_LABELS,
  EVAL_SCORE_HINT,
  formatDateTime,
  formatEvalScore,
  formatPercent,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { INCOMPLETE_SCORE_TEXT, TaskStatusNote, evalScoreView } from './task-list-parts';

/** 分区标题：把详情页分成「概要 / 结论 / 明细 / 专项」几个层级，统一字号与间距。 */
export function SectionHeading({
  title,
  hint,
  className,
}: {
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-3 pt-2', className)}>
      <h2 className="shrink-0 text-[13px] font-bold tracking-[0.08em] text-ink-3">{title}</h2>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      {hint && <span className="shrink-0 text-xs text-ink-3">{hint}</span>}
    </div>
  );
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-ink-3">{label}</div>
      <div className="mt-1 min-w-0 break-words text-[13.5px] text-ink">{children}</div>
    </div>
  );
}

/** 顶部概要卡：任务名、状态、得分、操作，下方是进度与评估对象/引擎/时间/样本库。 */
export function TaskSummaryCard({
  task: t,
  actions,
}: {
  task: EvalTaskDetail;
  actions: ReactNode;
}) {
  const pct = t.totalQuestions ? Math.min(t.processedQuestions / t.totalQuestions, 1) : 0;
  const scoreView = evalScoreView(t);
  return (
    <Card>
      <div className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0 flex-1 basis-[420px]">
            <h1 className="break-words text-[22px] font-bold leading-snug text-ink">{t.name}</h1>
            <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <TaskStatusBadge value={t.status} />
              {(scoreView.kind === 'incomplete' ||
                (scoreView.kind === 'score' && scoreView.value != null)) && (
                <span
                  className="rounded-md bg-brand-50 px-2 py-0.5 text-[13px] font-semibold tabular-nums text-brand-700 ring-1 ring-inset ring-brand-100"
                  title={EVAL_SCORE_HINT}
                >
                  综合评估得分{' '}
                  {scoreView.kind === 'incomplete'
                    ? INCOMPLETE_SCORE_TEXT
                    : formatEvalScore(scoreView.kind === 'score' ? scoreView.value : null)}
                </span>
              )}
              <TaskStatusNote targetType={t.modelTarget?.targetType} description={t.description} />
            </div>
            {t.description && t.modelTarget?.targetType !== 'ENDPOINT_AGENT' && (
              <p
                className="mt-2 line-clamp-2 break-words text-[13px] leading-5 text-ink-3"
                title={t.description}
              >
                {t.description}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
        </div>

        <div className="mt-5 border-t border-line pt-5">
          <div className="mb-2 flex items-center justify-between text-[13px]">
            <span className="text-ink-3">执行进度</span>
            <span className="tabular-nums text-ink">
              {t.processedQuestions}/{t.totalQuestions}（{formatPercent(pct, 0)}）
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                t.status === 'FAILED'
                  ? 'bg-severity-critical'
                  : t.status === 'COMPLETED'
                    ? 'bg-severity-pass'
                    : 'bg-brand-600',
              )}
              style={{ width: `${Math.round(pct * 100)}%` }}
            />
          </div>
          <div className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetaItem label="评估对象">
              {t.modelTarget ? `${t.modelTarget.name}（${t.modelTarget.model}）` : '—'}
            </MetaItem>
            <MetaItem label="安全引擎">
              <div className="flex flex-wrap gap-1">
                {t.engines.length > 0 ? (
                  t.engines.map((e) => (
                    <Badge key={e} tone="info">
                      {ENGINE_LABELS[e as keyof typeof ENGINE_LABELS] ?? e}
                    </Badge>
                  ))
                ) : (
                  <span className="text-ink-3">默认内置</span>
                )}
              </div>
            </MetaItem>
            <MetaItem label="开始时间">
              <span className="tabular-nums">
                {t.startedAt ? formatDateTime(t.startedAt) : '—'}
              </span>
            </MetaItem>
            <MetaItem label="完成时间">
              <span className="tabular-nums">
                {t.finishedAt ? formatDateTime(t.finishedAt) : '—'}
              </span>
            </MetaItem>
          </div>
          {t.questionSets.length > 0 && (
            <div className="mt-4">
              <div className="text-xs text-ink-3">样本库</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {t.questionSets.map((s) => (
                  <Badge key={s.id} tone="neutral" className="max-w-full truncate" title={s.name}>
                    {s.name}（{s.questionCount}）
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** 指标条里的一格。 */
export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div className="px-5 py-3">
      <div className="text-xs text-ink-3">{label}</div>
      <div className={cn('mt-0.5 text-[19px] font-bold tabular-nums text-ink', tone)}>{value}</div>
    </div>
  );
}
