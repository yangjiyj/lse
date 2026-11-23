// 组合报告（2.6.3）详情：任务清单（可跳转，已删除、已迁走的任务标出）、合并后的风险等级分布、跨任务主要风险。
import { Link } from 'react-router-dom';
import type { Report } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { formatDateTime, severityLabel } from '@/lib/format';

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN', 'UNSPECIFIED'];
const TOP_RISK_SHOWN = 10;

export const DELETED_TASK_LABEL = '任务已删除';
export const MOVED_TASK_LABEL = '任务已移出本租户';

/** 任务已删除或已迁到别的租户时的标记；正常任务为空。 */
function taskMark(t: { deleted: boolean; movedOut?: boolean }): string | null {
  return t.deleted ? DELETED_TASK_LABEL : t.movedOut ? MOVED_TASK_LABEL : null;
}

interface CombinedTopRisk {
  title: string;
  severity: string;
  severityLabel: string;
  domainLabel: string;
  count: number;
  taskIds: string[];
}

function topRisksOf(report: Report): CombinedTopRisk[] {
  const raw = (report.summary as unknown as { topRisks?: unknown }).topRisks;
  return Array.isArray(raw) ? (raw as CombinedTopRisk[]) : [];
}

function headlineOf(report: Report): string {
  const raw = (report.summary as unknown as { headline?: unknown }).headline;
  return typeof raw === 'string' ? raw : '';
}

export function CombinedReportDetail({ report }: { report: Report }) {
  const tasks = report.tasks ?? [];
  const names = new Map(
    tasks.map((t) => {
      const mark = taskMark(t);
      return [t.id, mark ? `${t.name}（${mark}）` : t.name];
    }),
  );
  const bySeverity = report.riskDistribution?.bySeverity ?? {};
  const severities = SEVERITY_ORDER.filter((k) => (bySeverity[k] ?? 0) > 0);
  const topRisks = topRisksOf(report);
  const headline = headlineOf(report);

  return (
    <div className="space-y-5">
      {headline ? <p className="text-[14px] font-semibold text-ink">{headline}</p> : null}

      <section className="space-y-2">
        <h3 className="text-[14px] font-bold text-ink">任务清单</h3>
        <Table>
          <THead>
            <TR>
              <TH>任务</TH>
              <TH>评估对象</TH>
              <TH>模型</TH>
              <TH>完成时间</TH>
              <TH>得分</TH>
              <TH>风险数</TH>
            </TR>
          </THead>
          <TBody>
            {tasks.map((t) => (
              <TR key={t.id}>
                <TD data-label="任务">
                  {taskMark(t) ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5 text-ink-3">
                      {t.name}
                      <Badge tone="neutral">{taskMark(t)}</Badge>
                    </span>
                  ) : (
                    <Link
                      to={`/eval-tasks/${t.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {t.name}
                    </Link>
                  )}
                </TD>
                <TD data-label="评估对象">{t.targetName}</TD>
                <TD data-label="模型">{t.model}</TD>
                <TD data-label="完成时间" className="whitespace-nowrap text-xs text-ink-3">
                  {formatDateTime(t.finishedAt)}
                </TD>
                <TD data-label="得分" className="tabular-nums">
                  {t.score == null ? '—' : t.score.toFixed(1)}
                </TD>
                <TD data-label="风险数" className="tabular-nums">
                  {t.findingCount}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </section>

      {severities.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-[14px] font-bold text-ink">风险等级分布</h3>
          <div className="flex flex-wrap gap-2">
            {severities.map((k) => (
              <Badge
                key={k}
                tone={
                  k === 'CRITICAL'
                    ? 'critical'
                    : k === 'HIGH'
                      ? 'danger'
                      : k === 'MEDIUM'
                        ? 'warning'
                        : 'info'
                }
              >
                {k === 'UNKNOWN' || k === 'UNSPECIFIED' ? '未定级' : severityLabel(k)}{' '}
                {bySeverity[k]}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}

      {topRisks.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-[14px] font-bold text-ink">主要风险</h3>
          <Table>
            <THead>
              <TR>
                <TH>严重度</TH>
                <TH>风险类别</TH>
                <TH>典型问题</TH>
                <TH>数量</TH>
                <TH>来源任务</TH>
              </TR>
            </THead>
            <TBody>
              {topRisks.slice(0, TOP_RISK_SHOWN).map((r, i) => (
                <TR key={`${r.severity}-${r.title}-${i}`}>
                  <TD data-label="严重度">{r.severityLabel}</TD>
                  <TD data-label="风险类别">{r.domainLabel}</TD>
                  <TD data-label="典型问题">{r.title}</TD>
                  <TD data-label="数量" className="tabular-nums">
                    {r.count}
                  </TD>
                  <TD data-label="来源任务">
                    {r.taskIds.map((id) => names.get(id) ?? DELETED_TASK_LABEL).join('、')}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </section>
      ) : null}
    </div>
  );
}
