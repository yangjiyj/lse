import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { EvalRegressionQuestion, EvalRegressionResult } from '@/lib/api';
import {
  EVAL_SCORE_HINT,
  formatDateTime,
  formatEvalScore,
  formatPercent,
  verdictLabel,
} from '@/lib/format';
import { differenceTone, formatFailRateWithInterval } from '@/components/EvalCredibility';
import { Card, CardContent } from '@/components/ui/card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { TaskStatusBadge } from '@/components/ui/status-badge';

const UP = 'text-severity-pass';
const DOWN = 'text-severity-critical';

/** 分数变化：保留 1 位小数并带符号；上升为成功色，下降为高风险色。 */
export function formatScoreDelta(delta: number | null): { text: string; className: string } {
  if (delta === null) return { text: '—', className: '' };
  if (delta === 0) return { text: '0.0', className: '' };
  return {
    text: `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`,
    className: delta > 0 ? UP : DOWN,
  };
}

/** 通过率变化（0–1 差值）→ 百分点。 */
export function formatRateDelta(delta: number | null): { text: string; className: string } {
  if (delta === null) return { text: '—', className: '' };
  const pp = Math.round(delta * 1000) / 10;
  if (pp === 0) return { text: '0.0 个百分点', className: '' };
  return {
    text: `${pp > 0 ? '+' : ''}${pp.toFixed(1)} 个百分点`,
    className: pp > 0 ? UP : DOWN,
  };
}

type ListKey = 'newlyFailed' | 'fixed' | 'stillFailing';
const LISTS: Array<{ key: ListKey; label: string }> = [
  { key: 'newlyFailed', label: '新增失败' },
  { key: 'fixed', label: '已修复' },
  { key: 'stillFailing', label: '仍失败' },
];

function Delta({ value }: { value: { text: string; className: string } }) {
  return <span className={`tabular-nums ${value.className}`}>{value.text}</span>;
}

function QuestionTable({ label, rows }: { label: string; rows: EvalRegressionQuestion[] }) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-slate-500">暂无数据</p>;
  return (
    <Table aria-label={`${label}题目`}>
      <THead>
        <TR>
          <TH>题目编号</TH>
          <TH>类别</TH>
          <TH>题目内容</TH>
          <TH>基线判定</TH>
          <TH>本次判定</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.questionId} className="h-10">
            <TD data-label="题目编号" className="font-mono text-xs text-slate-500">
              {r.externalId ?? r.questionId.slice(0, 8)}
            </TD>
            <TD data-label="类别">{r.category}</TD>
            <TD data-label="题目内容" className="max-w-md">
              <span className="line-clamp-2" title={r.content}>
                {r.content || '—'}
              </span>
            </TD>
            <TD data-label="基线判定">{verdictLabel(r.baseVerdict)}</TD>
            <TD data-label="本次判定">{verdictLabel(r.headVerdict)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function RegressionView({ data }: { data: EvalRegressionResult }) {
  const [tab, setTab] = useState<ListKey>('newlyFailed');
  const { base, head, summary } = data;
  const active = LISTS.find((l) => l.key === tab)!;
  const truncated = summary[tab] > data[tab].length;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-6">
          <Table aria-label="回归对比概览">
            <THead>
              <TR>
                <TH>运行</TH>
                <TH>任务</TH>
                <TH>状态</TH>
                <TH>完成时间</TH>
                <TH title={EVAL_SCORE_HINT}>评估得分</TH>
                <TH>通过率</TH>
                <TH>失败率（置信区间）</TH>
                <TH>失败</TH>
                <TH>执行异常</TH>
              </TR>
            </THead>
            <TBody>
              {[
                { label: '基线（上次）', t: base },
                { label: '本次', t: head },
              ].map(({ label, t }) => (
                <TR key={t.id} className="h-10">
                  <TD data-label="运行" className="font-medium">
                    {label}
                  </TD>
                  <TD data-label="任务">
                    <Link to={`/eval-tasks/${t.id}`} className="text-brand-600 hover:underline">
                      {t.name}
                    </Link>
                  </TD>
                  <TD data-label="状态">
                    <TaskStatusBadge value={t.status} />
                  </TD>
                  <TD data-label="完成时间" className="tabular-nums">
                    {t.finishedAt ? formatDateTime(t.finishedAt) : '—'}
                  </TD>
                  <TD data-label="评估得分" className="tabular-nums">
                    {formatEvalScore(t.evalScore)}
                  </TD>
                  <TD data-label="通过率" className="tabular-nums">
                    {formatPercent(t.passRate, 1)}
                  </TD>
                  <TD data-label="失败率（置信区间）" className="tabular-nums">
                    {formatFailRateWithInterval(t.statistics)}
                  </TD>
                  <TD data-label="失败" className="tabular-nums">
                    {t.failedCount}
                  </TD>
                  <TD data-label="执行异常" className="tabular-nums">
                    {t.errorCount}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <dl
            aria-label="回归变化汇总"
            className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-200 pt-4 text-sm sm:grid-cols-4 lg:grid-cols-7"
          >
            {[
              ['对齐题目', String(summary.aligned), ''],
              ['新增失败', String(summary.newlyFailed), summary.newlyFailed > 0 ? DOWN : ''],
              ['已修复', String(summary.fixed), summary.fixed > 0 ? UP : ''],
              ['仍失败', String(summary.stillFailing), ''],
              [
                '得分变化',
                formatScoreDelta(summary.scoreDelta).text,
                formatScoreDelta(summary.scoreDelta).className,
              ],
              [
                '通过率变化',
                formatRateDelta(summary.passRateDelta).text,
                formatRateDelta(summary.passRateDelta).className,
              ],
              ['未对齐题目', `${summary.onlyInBase + summary.onlyInHead}`, ''],
            ].map(([k, v, cls]) => (
              <div key={k}>
                <dt className="text-slate-500">{k}</dt>
                <dd className={`mt-1 text-[19px] font-bold tabular-nums ${cls}`}>{v}</dd>
              </div>
            ))}
          </dl>
          {summary.failRateDifference ? (
            <p className="mt-3 text-sm" data-testid="fail-rate-difference">
              失败率变化是否可信：
              <span className={differenceTone(summary.failRateDifference).className}>
                {summary.failRateDifference.message}
              </span>
              <span className="ml-2 text-xs text-slate-500">
                （比较两次运行失败率的 95% 置信区间是否重叠，区间重叠即视为未超出统计波动）
              </span>
            </p>
          ) : null}
          <p className="mt-3 text-xs text-slate-500">
            按题目对齐两次运行；失败含“未通过”与“执行异常”。未对齐题目：仅基线有{' '}
            {summary.onlyInBase} 题、仅本次有 {summary.onlyInHead}{' '}
            题，不计入变化。得分为平台评分，非认证结论。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div
            role="tablist"
            aria-label="题目变化"
            className="mb-3 flex gap-6 border-b border-slate-200"
          >
            {LISTS.map((l) => (
              <button
                key={l.key}
                type="button"
                role="tab"
                aria-selected={tab === l.key}
                className={`-mb-px border-b-2 pb-2 text-sm ${
                  tab === l.key
                    ? 'border-brand-600 text-brand-600'
                    : 'border-transparent text-slate-600 hover:text-brand-600'
                }`}
                onClick={() => setTab(l.key)}
              >
                {l.label}（{summary[l.key]}）
              </button>
            ))}
          </div>
          <QuestionTable label={active.label} rows={data[tab]} />
          {truncated && (
            <p className="mt-2 text-xs text-slate-500">
              仅显示前 {data[tab].length} 条，共 {summary[tab]} 条。
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <h2 className="mb-4 text-[15px] font-bold text-ink">各类别变化</h2>
          {data.categories.length === 0 ? (
            <p className="text-sm text-slate-500">暂无数据</p>
          ) : (
            <Table aria-label="各类别变化">
              <THead>
                <TR>
                  <TH>类别</TH>
                  <TH>对齐题目</TH>
                  <TH>基线通过率</TH>
                  <TH>本次通过率</TH>
                  <TH>通过率变化</TH>
                  <TH>新增失败</TH>
                  <TH>已修复</TH>
                  <TH>仍失败</TH>
                </TR>
              </THead>
              <TBody>
                {data.categories.map((c) => (
                  <TR key={c.category} className="h-10">
                    <TD data-label="类别">{c.category}</TD>
                    <TD data-label="对齐题目" className="tabular-nums">
                      {c.aligned}
                    </TD>
                    <TD data-label="基线通过率" className="tabular-nums">
                      {formatPercent(c.basePassRate, 1)}
                    </TD>
                    <TD data-label="本次通过率" className="tabular-nums">
                      {formatPercent(c.headPassRate, 1)}
                    </TD>
                    <TD data-label="通过率变化">
                      <Delta value={formatRateDelta(c.passRateDelta)} />
                    </TD>
                    <TD
                      data-label="新增失败"
                      className={`tabular-nums ${c.newlyFailed ? DOWN : ''}`}
                    >
                      {c.newlyFailed}
                    </TD>
                    <TD data-label="已修复" className={`tabular-nums ${c.fixed ? UP : ''}`}>
                      {c.fixed}
                    </TD>
                    <TD data-label="仍失败" className="tabular-nums">
                      {c.stillFailing}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
