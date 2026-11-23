import type { RagGroupMetrics, RagMetricSummary } from '@/lib/api';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatPercent } from '@/lib/format';

const METRIC_LABEL: Record<string, string> = { hitAtK: '检索命中率', mrr: '平均倒数排名' };

function rateColor(rate: number | null): string {
  if (rate === null) return 'text-slate-500';
  if (rate >= 0.8) return 'text-severity-pass';
  if (rate >= 0.5) return 'text-severity-high';
  return 'text-severity-critical';
}

/** 单项指标行：有样本给通过率；全部未评估时写“未评估（原因）”。 */
function MetricRow({ m, showAverage }: { m: RagMetricSummary; showAverage?: boolean }) {
  const partial = m.samples > 0 && m.samples < m.applicable;
  const reasons = m.notEvaluatedReasons.map(r => `${r.reason}（${r.count}）`).join('；');
  const allNotEvaluated = m.applicable > 0 && m.samples === 0;
  const value = showAverage
    ? m.average === null ? '—' : m.average.toFixed(3)
    : partial && m.passRate !== null
      ? `${(m.passRate * 100).toFixed(1).replace(/\.0$/, '')}%`
      : formatPercent(m.passRate);
  return (
    <TR>
      <TD data-label="指标" className="whitespace-nowrap font-medium">
        {METRIC_LABEL[m.key] ?? m.label}
      </TD>
      <TD data-label="结果">
        {m.applicable === 0 ? (
          <span className="text-xs text-slate-500">测试集不含该类题目</span>
        ) : allNotEvaluated ? (
          <span className="text-xs text-slate-500">
            未评估（{m.notEvaluatedReasons[0]?.reason.replace(/^未评估[:：]?/, '') ?? '原因未知'}）
          </span>
        ) : (
          <span className={rateColor(showAverage ? m.average : m.passRate)}>
            {value}{partial ? `（${m.samples}/${m.applicable} 已评估）` : ''}
          </span>
        )}
        {partial && reasons && <span className="block text-xs text-slate-500">{reasons}</span>}
      </TD>
      <TD data-label="样本">
        {partial ? '—' : `${m.samples}/${m.applicable}`}
        {m.extra?.needsReview ? (
          <span className="ml-2 text-xs text-severity-high">需人工复核 {m.extra.needsReview}</span>
        ) : null}
      </TD>
      <TD data-label="未评估原因" className="text-xs text-slate-500">
        {partial || m.notEvaluated === 0
          ? '—'
          : m.notEvaluatedReasons.map((r) => `${r.reason}（${r.count}）`).join('；')}
      </TD>
    </TR>
  );
}

function GroupTable({
  title,
  rows,
  averageKeys = [],
}: {
  title: string;
  rows: RagMetricSummary[];
  averageKeys?: string[];
}) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <Table>
        <THead>
          <TR>
            <TH>指标</TH>
            <TH>结果</TH>
            <TH>已评估/适用</TH>
            <TH>未评估原因</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((m) => (
            <MetricRow key={m.key} m={m} showAverage={averageKeys.includes(m.key)} />
          ))}
        </TBody>
      </Table>
    </section>
  );
}

/** 结果按“生成质量 / 检索质量 / 安全项”分组。 */
export function RunGroups({ groups }: { groups: RagGroupMetrics }) {
  const sections = [
    { title: '生成质量', rows: groups.generation },
    { title: '检索质量', rows: groups.retrieval, averageKeys: ['mrr'] },
    { title: '安全项', rows: groups.security },
  ];
  const omitted = sections.filter(s => !s.rows.some(m => m.applicable > 0));
  return (
    <div className="space-y-5">
      {sections.filter(s => s.rows.some(m => m.applicable > 0)).map(s => <GroupTable key={s.title} {...s} />)}
      {omitted.length > 0 && <p className="text-sm text-slate-500">本次未涉及：{omitted.map(s => s.title).join('、')}</p>}
    </div>
  );
}
