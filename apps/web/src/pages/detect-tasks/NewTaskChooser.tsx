import { Link } from 'react-router-dom';
import {
  canCreateToolTask,
  DETECT_CATEGORIES,
  DETECT_CATEGORY_LABELS,
  TOOL_TASK_ENTRIES,
  type ToolTaskEntry,
} from '@lse/shared';
import { Modal } from '@/components/ui/modal';
import { useAuth } from '@/lib/auth';

const ENTRIES = Object.values(TOOL_TASK_ENTRIES) as ToolTaskEntry[];

const tile =
  'block rounded-lg border border-line px-3 py-2.5 text-[13.5px] font-medium text-ink transition';

/** 「新建检测任务」：按四类列出各类检测入口，跳到各自的建任务页；没有权限的置灰。另有组合任务。 */
export function NewTaskChooser({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const canManageJobs = hasPermission('detect_task:manage');
  return (
    <Modal open={open} onClose={onClose} title="新建检测任务">
      <div className="space-y-5">
        {DETECT_CATEGORIES.map((category) => {
          const entries = ENTRIES.filter((e) => e.category === category);
          if (entries.length === 0) return null;
          return (
            <section key={category}>
              <h3 className="mb-2 text-[13px] font-semibold text-ink-3">
                {DETECT_CATEGORY_LABELS[category]}
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {entries.map((entry) =>
                  canCreateToolTask(entry, hasPermission) ? (
                    <Link
                      key={entry.key}
                      to={entry.createPath}
                      onClick={onClose}
                      className={`${tile} hover:border-brand-400 hover:bg-brand-50`}
                    >
                      {entry.label}
                    </Link>
                  ) : (
                    <span
                      key={entry.key}
                      aria-disabled="true"
                      className={`${tile} cursor-not-allowed text-ink-4 opacity-60`}
                    >
                      {entry.label}
                    </span>
                  ),
                )}
              </div>
            </section>
          );
        })}
        <section>
          <h3 className="mb-2 text-[13px] font-semibold text-ink-3">组合</h3>
          {canManageJobs ? (
            <Link
              to="/detect-tasks/jobs?new=1"
              onClick={onClose}
              className={`${tile} hover:border-brand-400 hover:bg-brand-50`}
            >
              组合任务
            </Link>
          ) : (
            <span
              aria-disabled="true"
              className={`${tile} cursor-not-allowed text-ink-4 opacity-60`}
            >
              组合任务
            </span>
          )}
        </section>
      </div>
    </Modal>
  );
}
