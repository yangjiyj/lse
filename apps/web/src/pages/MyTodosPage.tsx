import { useState, type MouseEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { QueryState } from '@/components/QueryState';
import { PageHeader } from '@/components/PageHeader';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import { SeverityBadge } from '@/components/ui/severity-badge';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { mergeTodosByTask, reviewTaskRows } from '@/components/eval-tasks/todo-merge';
import { TenantFilterSelect, useTenantView } from '@/lib/tenant-view';

const ACTION_LINK =
  'inline-flex h-8 shrink-0 items-center rounded-[9px] px-3 text-[13px] font-medium transition-colors';
// 待复核任务每页条数；与风险处置台的「待复核」筛选同一口径（见后端 review-scope.ts）。
const REVIEW_TASK_PAGE_SIZE = 10;
const REVIEW_LIST_LINK = '/wrong-answers?reviewStatus=pending';
const PRIMARY_LINK = `${ACTION_LINK} bg-brand-600 text-white hover:bg-brand-700`;
const GHOST_LINK = `${ACTION_LINK} bg-brand-50 text-brand-700 hover:bg-brand-100`;

function TodoSection({
  title,
  count,
  hint,
  tone = 'neutral',
  action,
  children,
}: {
  title: string;
  count: number;
  hint?: string;
  tone?: 'neutral' | 'danger' | 'warning' | 'critical';
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <header
        className={`flex flex-wrap items-center gap-3 px-5 py-3 ${count > 0 ? 'min-h-[56px] border-b border-line' : 'min-h-[48px]'}`}
      >
        <h2 className="text-[15px] font-bold text-ink">{title}</h2>
        {count > 0 ? (
          <Badge tone={tone} className="tabular-nums">
            {count}
          </Badge>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-severity-pass">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            已清零
          </span>
        )}
        {hint && <span className="text-xs text-ink-3">{hint}</span>}
        <div className="ml-auto">{action}</div>
      </header>
      {children}
    </Card>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-5 pb-3.5 text-[13px] text-ink-3">{children}</p>;
}

function Row({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <li className="flex min-h-[56px] items-center justify-between gap-4 border-b border-[#EEF2F8] px-5 py-2.5 last:border-b-0 hover:bg-brand-50/40">
      <div className="min-w-0 flex-1">{children}</div>
      <div className="flex shrink-0 items-center gap-2">{action}</div>
    </li>
  );
}

function TitleChips({ titles, limit = 3 }: { titles: string[]; limit?: number }) {
  if (titles.length === 0) return null;
  return (
    <div className="mt-1 truncate text-xs text-ink-3" title={titles.join('、')}>
      {titles.slice(0, limit).join('、')}
      {titles.length > limit ? ` 等 ${titles.length} 类` : ''}
    </div>
  );
}

export function MyTodosPage() {
  const { hasPermission } = useAuth();
  const { isAllTenants, tenantFilter, tenantName, guardRow } = useTenantView();
  const matchTenant = (id?: string | null) => !isAllTenants || !tenantFilter || id === tenantFilter;
  const tag = (id?: string | null) =>
    isAllTenants ? (
      <span data-testid="tenant-cell" className="ml-1 shrink-0 text-xs text-ink-3">
        · {tenantName(id)}
      </span>
    ) : null;
  const guardLink =
    (id: string | null | undefined, path: string) => (e: MouseEvent<HTMLAnchorElement>) => {
      if (guardRow(id, path)) e.preventDefault();
    };
  const enabled = hasPermission('eval_task:read');
  // 风险处置台需要 wrong_answer:export；没有该权限的账号仍回到评估任务详情去复核。
  const canDispose = hasPermission('wrong_answer:export');
  const [reviewPage, setReviewPage] = useState(1);
  const query = useQuery({
    queryKey: ['dashboard', 'todos', reviewPage],
    queryFn: () =>
      api.dashboard.todos({
        reviewTaskPage: reviewPage,
        reviewTaskPageSize: REVIEW_TASK_PAGE_SIZE,
      }),
    enabled,
    placeholderData: (prev) => prev,
  });
  const todos = query.data;

  // 待复核按任务分组：每个任务旁的数量是该任务真实待复核数，列出全部有待复核的任务（分页）。
  const reviewTasks = todos ? reviewTaskRows(todos.review) : [];
  const reviewTaskTotal = todos?.review.taskTotal ?? reviewTasks.length;
  const remediationTasks = todos ? mergeTodosByTask(todos.remediation.items) : [];
  const remediationCount = todos && todos.gates.remediation ? todos.remediation.count : 0;
  const connectionCount = todos && todos.gates.connection ? todos.connection.count : 0;
  const gateCount = todos && todos.gates.planning ? todos.gate.count : 0;
  const overdue = todos?.remediation.items.filter((i) => i.overdue).length ?? 0;
  const totalCount = todos
    ? todos.review.count + remediationCount + connectionCount + gateCount
    : 0;

  // 优先级：门禁未过 > 整改逾期 > 接入异常 > 待复核；同级按数量。无待办的分组沉到最后。
  const sections: Array<{ key: string; weight: number; node: ReactNode }> = [];
  if (todos) {
    sections.push({
      key: 'gate',
      weight: gateCount > 0 ? 400 : 0,
      node: (
        <TodoSection
          key="gate"
          title="门禁未过"
          count={gateCount}
          tone="critical"
          action={
            gateCount > 0 ? (
              <Link className={PRIMARY_LINK} to="/eval/gates">
                查看门禁
              </Link>
            ) : null
          }
        >
          {!todos.gates.planning ? (
            <EmptyLine>暂无门禁权限</EmptyLine>
          ) : todos.gate.items.length ? (
            <ul>
              {todos.gate.items.map((item) => (
                <Row
                  key={item.gateId}
                  action={
                    <Link className={GHOST_LINK} to={`/eval-tasks/${item.taskId}`}>
                      查看任务
                    </Link>
                  }
                >
                  <div className="truncate text-[13.5px] font-medium text-ink">
                    {item.gateName} · {item.taskName ?? '评估任务'}
                  </div>
                  {item.reasons.length > 0 && (
                    <div className="mt-1 text-xs text-severity-critical">
                      {item.reasons.join('；')}
                    </div>
                  )}
                </Row>
              ))}
            </ul>
          ) : (
            <EmptyLine>暂无数据</EmptyLine>
          )}
        </TodoSection>
      ),
    });
    sections.push({
      key: 'remediation',
      weight: remediationCount > 0 ? 300 + (overdue > 0 ? 50 : 0) : 0,
      node: (
        <TodoSection
          key="remediation"
          title="待整改到期"
          count={remediationCount}
          tone={overdue > 0 ? 'danger' : 'warning'}
          hint={overdue > 0 ? `其中 ${overdue} 项已逾期` : undefined}
          action={
            remediationTasks[0] ? (
              <Link className={PRIMARY_LINK} to={`/eval-tasks/${remediationTasks[0].taskId}`}>
                去处理
              </Link>
            ) : null
          }
        >
          {!todos.gates.remediation ? (
            <EmptyLine>暂无整改权限</EmptyLine>
          ) : remediationTasks.length ? (
            <ul>
              {remediationTasks
                .filter((g) => matchTenant(g.tenantId))
                .map((g) => (
                  <Row
                    key={g.taskId}
                    action={
                      <Link
                        className={GHOST_LINK}
                        to={`/eval-tasks/${g.taskId}`}
                        onClick={guardLink(g.tenantId, `/eval-tasks/${g.taskId}`)}
                      >
                        查看任务
                      </Link>
                    }
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="truncate text-[13.5px] font-medium text-ink"
                        title={g.taskName}
                      >
                        {g.taskName}
                      </span>
                      {tag(g.tenantId)}
                      <SeverityBadge value={g.topSeverity} />
                      {g.overdueCount > 0 && (
                        <Badge tone="danger" className="px-1.5">
                          已逾期
                          {g.overdueCount > 1 ? ` ${g.overdueCount} 项` : ''}
                        </Badge>
                      )}
                      <span className="shrink-0 text-xs text-ink-3">{g.count} 项整改</span>
                    </div>
                    <TitleChips titles={g.titles} />
                    {g.earliestDue && (
                      <div className="mt-0.5 text-xs text-ink-3">
                        最近到期 {formatDateTime(g.earliestDue)}
                      </div>
                    )}
                  </Row>
                ))}
            </ul>
          ) : (
            <EmptyLine>暂无数据</EmptyLine>
          )}
        </TodoSection>
      ),
    });
    sections.push({
      key: 'connection',
      weight: connectionCount > 0 ? 200 : 0,
      node: (
        <TodoSection
          key="connection"
          title="接入异常"
          count={connectionCount}
          tone="warning"
          action={
            connectionCount > 0 ? (
              <Link className={PRIMARY_LINK} to="/model-targets">
                去处理
              </Link>
            ) : null
          }
        >
          {!todos.gates.connection ? (
            <EmptyLine>暂无对象权限</EmptyLine>
          ) : todos.connection.items.length ? (
            <ul>
              {todos.connection.items
                .filter((item) => matchTenant(item.tenantId))
                .map((item) => (
                  <Row
                    key={item.targetId}
                    action={
                      <Link
                        className={GHOST_LINK}
                        to="/model-targets"
                        onClick={guardLink(item.tenantId, '/model-targets')}
                      >
                        查看对象
                      </Link>
                    }
                  >
                    <span className="text-[13.5px] font-medium text-ink">
                      {item.targetName} · {item.active ? item.lastTestStatus : '已停用'}
                    </span>
                    {tag(item.tenantId)}
                  </Row>
                ))}
            </ul>
          ) : (
            <EmptyLine>暂无数据</EmptyLine>
          )}
        </TodoSection>
      ),
    });
    sections.push({
      key: 'review',
      weight: todos.review.count > 0 ? 100 : 0,
      node: (
        <TodoSection
          key="review"
          title="待复核"
          count={todos.review.count}
          tone="warning"
          hint={`全部时间 · 涉及 ${reviewTaskTotal} 个评估任务`}
          action={
            reviewTasks[0] ? (
              <Link
                className={PRIMARY_LINK}
                to={canDispose ? REVIEW_LIST_LINK : `/eval-tasks/${reviewTasks[0].taskId}`}
              >
                {canDispose ? '去处置台' : '去处理'}
              </Link>
            ) : null
          }
        >
          {reviewTasks.length ? (
            <>
              <ul>
                {reviewTasks
                  .filter((g) => matchTenant(g.tenantId))
                  .map((g) => (
                    <Row
                      key={g.taskId}
                      action={
                        <Link
                          className={GHOST_LINK}
                          to={
                            canDispose
                              ? `${REVIEW_LIST_LINK}&taskId=${g.taskId}`
                              : `/eval-tasks/${g.taskId}`
                          }
                          onClick={guardLink(
                            g.tenantId,
                            canDispose
                              ? `${REVIEW_LIST_LINK}&taskId=${g.taskId}`
                              : `/eval-tasks/${g.taskId}`,
                          )}
                        >
                          去复核
                        </Link>
                      }
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="truncate text-[13.5px] font-medium text-ink"
                          title={g.taskName}
                        >
                          {g.taskName}
                        </span>
                        {tag(g.tenantId)}
                        <SeverityBadge value={g.topSeverity} />
                        <span className="shrink-0 text-xs text-ink-3">{g.count} 项待复核</span>
                      </div>
                      <TitleChips titles={g.titles} />
                    </Row>
                  ))}
              </ul>
              {reviewTaskTotal > REVIEW_TASK_PAGE_SIZE && (
                <div className="border-t border-[#EEF2F8] px-5 pb-3">
                  <Pagination
                    page={reviewPage}
                    pageSize={REVIEW_TASK_PAGE_SIZE}
                    total={reviewTaskTotal}
                    onPageChange={setReviewPage}
                  />
                </div>
              )}
            </>
          ) : (
            <EmptyLine>暂无数据</EmptyLine>
          )}
        </TodoSection>
      ),
    });
    sections.sort((a, b) => b.weight - a.weight);
  }

  return (
    <div>
      <PageHeader
        title="我的待办"
        description={
          todos
            ? totalCount > 0
              ? `共 ${totalCount} 项待处理，按紧急程度排序（待复核 ${todos.review.count} 项，来自 ${reviewTaskTotal} 个任务）`
              : '当前没有待处理事项'
            : '需要你复核、整改与跟进的事项'
        }
        actions={<TenantFilterSelect />}
      />
      <QueryState
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={false}
        permissionDenied={!enabled}
        emptyTitle="暂无数据"
        emptyDescription="当前没有可查看的待办事项。"
      />
      {todos && <div className="space-y-4">{sections.map((s) => s.node)}</div>}
    </div>
  );
}
