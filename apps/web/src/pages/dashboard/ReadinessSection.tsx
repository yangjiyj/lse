import { Link } from 'react-router-dom';
import { Crosshair, FileSearch, ShieldCheck, ScanSearch } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DashboardOverview, ReadinessState } from '@/lib/api';
import { TaskStatusBadge } from '@/components/ui/status-badge';
import { useAuth } from '@/lib/auth';

const STATE_BAR: Record<ReadinessState, string> = {
  done: 'bg-emerald-500',
  active: 'bg-sky-500',
  pending: 'bg-slate-200',
  warn: 'bg-amber-400',
  failed: 'bg-red-500',
};

const STATE_TEXT_CLASS: Record<ReadinessState, string> = {
  done: 'text-emerald-700',
  active: 'text-sky-700',
  pending: 'text-slate-500',
  warn: 'text-amber-700',
  failed: 'text-severity-critical',
};

const STATE_TEXT: Record<ReadinessState, string> = {
  done: '就绪',
  active: '进行中',
  pending: '未就绪',
  warn: '需关注',
  failed: '异常',
};

type Stage = DashboardOverview['readiness'][number]['stages'][number];

/** 当前环节：优先展示异常/需关注环节，其次第一个未完成环节，全部完成时展示最后一个环节。 */
function currentStage(stages: Stage[]): Stage | undefined {
  return (
    stages.find((s) => s.state === 'failed') ??
    stages.find((s) => s.state === 'warn') ??
    stages.find((s) => s.state !== 'done') ??
    stages[stages.length - 1]
  );
}

/** 检测流程及各环节就绪状态：按任务名称、评估对象、启动状态、运行状态展示。 */
export function ReadinessTable({ rows }: { rows: DashboardOverview['readiness'] }) {
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">暂无检测任务</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-[13px]" aria-label="检测流程就绪状态">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
            <th className="h-9 pr-3 font-medium">任务名称</th>
            <th className="h-9 pr-3 font-medium">评估对象</th>
            <th className="h-9 w-20 pr-3 font-medium">启动状态</th>
            <th className="h-9 w-20 pr-3 font-medium">运行状态</th>
            <th className="h-9 w-[15rem] pr-3 font-medium">检测流程</th>
            <th className="h-9 font-medium">当前环节</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cur = currentStage(row.stages);
            const doneCount = row.stages.filter((s) => s.state === 'done').length;
            return (
              <tr
                key={row.taskId}
                className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70"
              >
                <td className="max-w-[18rem] py-2.5 pr-3">
                  <Link
                    to={`/eval-tasks/${row.taskId}`}
                    className="block truncate font-medium text-slate-900 hover:text-primary"
                    title={row.taskName}
                  >
                    {row.taskName}
                  </Link>
                </td>
                <td
                  className="max-w-[11rem] truncate py-2.5 pr-3 text-slate-600"
                  title={row.modelName}
                >
                  {row.modelName}
                </td>
                <td className="whitespace-nowrap py-2.5 pr-3 text-slate-600">{row.startStatus}</td>
                <td className="py-2.5 pr-3">
                  <TaskStatusBadge value={row.runStatus} />
                </td>
                <td className="py-2.5 pr-3">
                  <div className="flex items-center gap-2">
                    <ol
                      className="flex flex-1 gap-0.5"
                      aria-label={`检测流程 ${doneCount}/${row.stages.length}`}
                    >
                      {row.stages.map((s) => (
                        <li
                          key={s.key}
                          className={`h-1.5 flex-1 rounded-sm ${STATE_BAR[s.state]}`}
                          title={`${s.label}：${STATE_TEXT[s.state]}（${s.detail}）`}
                        />
                      ))}
                    </ol>
                    <span className="w-8 shrink-0 text-right text-xs tabular-nums text-slate-500">
                      {doneCount}/{row.stages.length}
                    </span>
                  </div>
                </td>
                <td className="whitespace-nowrap py-2.5">
                  {cur ? (
                    <span
                      className={`inline-flex items-center gap-1.5 ${STATE_TEXT_CLASS[cur.state]}`}
                    >
                      <span className="font-medium">{cur.label}</span>
                      <span className="text-slate-300">|</span>
                      <span>{cur.detail}</span>
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const QUICK_ENTRIES: Array<{
  to: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** 目标操作的写权限：评估发起为 eval_task:create，AI 组件静态扫描为 engine:scan。 */
  permission: string;
}> = [
  {
    to: '/eval-tasks?launch=redteam',
    permission: 'eval_task:create',
    label: '多轮对抗演练',
    hint: '攻击模型逐轮调整攻击，评估模型判定',
    icon: Crosshair,
  },
  {
    to: '/eval-tasks?launch=content',
    permission: 'eval_task:create',
    label: '内容安全评估',
    hint: '自动生成样本评估内容安全',
    icon: ShieldCheck,
  },
  {
    to: '/eval-tasks?launch=standard',
    permission: 'eval_task:create',
    label: '合规专项检测',
    hint: 'GB/T 45654 标准分类专项检测',
    icon: FileSearch,
  },
  {
    to: '/ai-asset-scan',
    permission: 'engine:scan',
    label: 'AI 组件漏洞扫描',
    hint: '插件、工具与技能的安全扫描',
    icon: ScanSearch,
  },
];

export function QuickEntries() {
  const { hasPermission } = useAuth();
  const entries = QUICK_ENTRIES.filter((e) => hasPermission(e.permission));
  if (entries.length === 0) return null;
  return (
    <nav aria-label="检测入口" className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-xs font-medium text-slate-500">快速发起</span>
      {entries.map(({ to, label, hint, icon: Icon }) => (
        <Link
          key={label}
          to={to}
          title={hint}
          className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-200 bg-white px-3 text-[13px] text-slate-700 transition-colors hover:border-primary/50 hover:text-primary"
        >
          <Icon className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
