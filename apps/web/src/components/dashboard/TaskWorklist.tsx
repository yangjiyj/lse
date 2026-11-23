import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks } from 'lucide-react';
import type { DashboardOverview } from '@/lib/api';
import { DashCard, type CardLoadState } from './DashCard';

type Tab = 'review' | 'connection' | 'all';
type Row = DashboardOverview['readiness'][number];

function currentStage(row: Row) {
  return (
    row.stages.find((s) => s.state === 'failed') ??
    row.stages.find((s) => s.state === 'warn') ??
    row.stages.find((s) => s.state === 'active') ??
    row.stages.find((s) => s.state !== 'done')
  );
}

/** 任务处置清单：待复核 / 接入异常 / 全部三个页签，保留「去复核」入口。 */
export function TaskWorklist({
  rows,
  connectionIssueCount,
  state,
}: {
  rows?: Row[];
  connectionIssueCount: number | null;
  state: CardLoadState;
}) {
  const [tab, setTab] = useState<Tab>('review');
  const tabs = useMemo(() => {
    const all = rows ?? [];
    return {
      review: all.filter((r) => r.stages.find((s) => s.key === 'review')?.state === 'active'),
      connection: all.filter((r) => r.connectionState === 'failed'),
      all,
    };
  }, [rows]);
  const selected = tabs[tab];
  const labels: Array<[Tab, string]> = [
    ['review', `待复核（${tabs.review.length}）`],
    ['connection', `接入异常（${connectionIssueCount ?? tabs.connection.length}）`],
    ['all', `全部（${tabs.all.length}）`],
  ];
  return (
    <DashCard
      title="任务处置清单"
      state={state}
      skeletonRows={4}
      action={
        state.isLoading || state.isError ? undefined : (
          <div
            className="flex gap-1 rounded-[10px] bg-canvas p-0.5"
            role="tablist"
            aria-label="任务列表"
          >
            {labels.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`h-7 rounded-lg px-3 text-[13px] ${tab === key ? 'bg-white font-semibold text-brand-700 shadow-sm' : 'text-ink-2 hover:text-ink'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )
      }
    >
      {selected.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="h-9 border-b border-line text-left text-xs text-ink-3">
                <th className="pr-3 font-medium">任务名称</th>
                <th className="pr-3 font-medium">评估对象</th>
                <th className="pr-3 font-medium">当前环节</th>
                <th className="font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {selected.map((row) => {
                const cur = currentStage(row);
                const warn = cur?.state === 'warn' || cur?.state === 'failed';
                return (
                  <tr key={row.taskId} className="h-11 border-b border-line/70 last:border-0">
                    <td className="max-w-[22rem] pr-3">
                      <Link
                        className="block truncate font-medium text-brand-600 hover:text-brand-700"
                        to={`/eval-tasks/${row.taskId}`}
                        title={row.taskName}
                      >
                        {row.taskName}
                      </Link>
                    </td>
                    <td className="max-w-[14rem] truncate pr-3 text-ink-2" title={row.modelName}>
                      {row.modelName}
                    </td>
                    <td className={`pr-3 ${warn ? 'text-severity-high' : 'text-ink-2'}`}>
                      {cur ? `${cur.label} · ${cur.detail}` : '—'}
                    </td>
                    <td className="whitespace-nowrap">
                      <Link
                        className="mr-3 text-brand-600 hover:text-brand-700"
                        to={`/eval-tasks/${row.taskId}`}
                      >
                        详情
                      </Link>
                      {cur?.key === 'review' && (
                        <Link
                          className="font-semibold text-brand-600 hover:text-brand-700"
                          to={`/eval-tasks/${row.taskId}`}
                        >
                          去复核
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-brand-50 text-brand-500">
            <ListChecks className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="text-[14px] font-semibold text-ink">暂无数据</div>
          <p className="text-[13px] text-ink-3">
            {tab === 'review'
              ? '没有处于待复核环节的任务。'
              : tab === 'connection'
                ? '没有接入异常的评估对象。'
                : '发起评估后在此汇总任务。'}
          </p>
        </div>
      )}
    </DashCard>
  );
}
