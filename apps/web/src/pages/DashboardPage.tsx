import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Clock3, Eye, ShieldAlert, Unplug } from 'lucide-react';
import { api, type DashboardRange } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { QueryState } from '@/components/QueryState';
import { PageHeader } from '@/components/PageHeader';
import { ActionList } from '@/components/dashboard/ActionList';
import { CategoryRadar, showCategoryRadar } from '@/components/dashboard/CategoryRadar';
import { CategoryTop } from '@/components/dashboard/CategoryTop';
import { ComponentSecurityCard } from '@/components/dashboard/ComponentSecurityCard';
import { DetectRiskCard } from '@/components/dashboard/DetectRiskCard';
import { dayRiskHref, riskListHref, taskListHref } from '@/components/dashboard/drill';
import { KpiCard, Sparkline } from '@/components/dashboard/KpiCard';
import { PostureHero, type HeroStats } from '@/components/dashboard/PostureHero';
import { QuickLaunch } from '@/components/dashboard/QuickLaunch';
import { RiskDistribution } from '@/components/dashboard/RiskDistribution';
import { RuleLibraryCard } from '@/components/dashboard/RuleLibraryCard';
import { TaskWorklist } from '@/components/dashboard/TaskWorklist';
import { TopTasks } from '@/components/dashboard/TopTasks';
import { TrendChart } from '@/components/dashboard/TrendChart';
import { RANGE_OPTIONS, rangeLabel, SEVERITY_ORDER } from '@/components/dashboard/utils';
import { useTenantView } from '@/lib/tenant-view';
import { canReadDetectRisks } from '@/lib/detect-risks';

function loadState(q: { isLoading: boolean; isError: boolean; refetch: () => unknown }) {
  return { isLoading: q.isLoading, isError: q.isError, onRetry: () => void q.refetch() };
}

export function DashboardPage() {
  const { hasPermission } = useAuth();
  const { isAllTenants, tenants, enterTenant } = useTenantView();
  const canReadTasks = hasPermission('eval_task:read');
  const canReadTargets = hasPermission('model_target:read');
  const canReadQuestions = hasPermission('question_set:read');
  const canReadAssurance = hasPermission('service_assurance:read');
  const canDispose = hasPermission('wrong_answer:export');
  const canReadRisks = canReadDetectRisks(hasPermission);
  const [period, setPeriod] = useState<DashboardRange>('month');
  const label = rangeLabel(period);

  const overview = useQuery({
    queryKey: ['dash', 'overview', period],
    queryFn: () => api.dashboard.overview({ period }),
    enabled: canReadTasks,
  });
  const posture = useQuery({
    queryKey: ['dash', 'posture', period],
    queryFn: () => api.dashboard.posture({ range: period }),
    enabled: canReadTasks,
  });
  const changes = useQuery({
    queryKey: ['dash', 'changes', period],
    queryFn: () => api.dashboard.changes({ range: period }),
    enabled: canReadTasks,
  });
  const categories = useQuery({
    queryKey: ['dash', 'risk-categories', period],
    queryFn: () => api.dashboard.riskCategories({ limit: 7, range: period }),
    enabled: canReadTasks,
  });
  const trend = useQuery({
    queryKey: ['dash', 'trend', 30],
    queryFn: () => api.dashboard.trend({ days: 30 }),
    enabled: canReadTasks,
  });
  const todos = useQuery({
    queryKey: ['dash', 'todos'],
    queryFn: () => api.dashboard.todos(),
    enabled: canReadTasks,
  });
  // 规则库不随统计周期变化：缓存键不带周期，切换周期不重取（服务端也按租户缓存 60 秒）。
  const ruleLibrary = useQuery({
    queryKey: ['dash', 'rule-library'],
    queryFn: () => api.dashboard.ruleLibrary(),
    enabled: canReadTasks,
    staleTime: 60_000,
  });
  const detectRisks = useQuery({
    queryKey: ['dash', 'detect-risks', period],
    queryFn: () => api.dashboard.detectRisks({ period }),
    enabled: canReadRisks,
  });
  const componentSecurity = useQuery({
    queryKey: ['dash', 'component-security'],
    queryFn: () => api.dashboard.componentSecurity(),
    enabled: canReadAssurance,
  });

  const ov = overview.data;
  const po = posture.data;
  const td = todos.data;
  const connectionIssueCount = ov?.connectionIssues?.count ?? null;
  const sev = po?.severityCounts;
  const findingTotal = sev ? SEVERITY_ORDER.reduce((s, k) => s + sev[k], 0) : null;

  const heroStats: HeroStats = {
    taskTotal: ov?.counts.taskTotal ?? null,
    periodTaskCount: ov?.counts.periodTaskCount ?? null,
    completedCount: ov ? (ov.taskStatus.find((s) => s.status === 'COMPLETED')?.count ?? 0) : null,
    // 与「风险等级分布」同口径（posture），避免同屏两个不一致的总数
    findingTotal,
    severity: sev
      ? { high: sev.CRITICAL + sev.HIGH, medium: sev.MEDIUM, low: sev.LOW + sev.INFO }
      : null,
    targetCount: ov && canReadTargets ? ov.counts.modelTargetCount : null,
    connectionIssues: connectionIssueCount,
    untested: ov?.connectionIssues ? ov.connectionIssues.untestedCount : null,
    // 与「规则库 · 题目」同口径，同屏两个题数一致。
    sampleTotal: ruleLibrary.data ? ruleLibrary.data.questions : null,
    runSetCount: ov ? (ov.counts.runQuestionSetCount ?? null) : null,
    toolCount: ov?.counts.tools ?? null,
  };

  const rawSpark = (trend.data?.points ?? []).map((p) => ({
    date: p.date,
    value: p.pendingReview,
  }));
  // 全为 0 时一条平线没有信息量，不画
  const sparkPoints = rawSpark.some((p) => p.value > 0) ? rawSpark : [];
  const showGate = !!td?.gates.planning;
  const modelFileCount = td?.modelFile
    ? td.modelFile.reviewCount + td.modelFile.remediationCount
    : 0;
  const todoState = loadState(todos);
  // 下钻带所选周期的起点（「全部」不带），与首页计数同一时间范围。
  const categoryHref = canDispose
    ? (domain: string) => riskListHref({ domain, since: categories.data?.periodStart })
    : undefined;
  const showRadar = showCategoryRadar(categories.data);
  const kpiLoading = todos.isLoading;
  const detectRiskCard = canReadRisks ? (
    <DetectRiskCard
      data={detectRisks.data}
      periodLabel={label}
      state={loadState(detectRisks)}
      postureFindingTotal={po?.facts.activeFindingTotal}
    />
  ) : null;

  return (
    <div className="pb-6">
      <PageHeader
        title="态势概览"
        description="实时汇总评估任务、风险回复与处置进度"
        actions={
          <>
            <div
              className="flex h-9 rounded-[10px] border border-line-2 bg-white p-0.5"
              role="group"
              aria-label="统计周期"
            >
              {RANGE_OPTIONS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={period === item.value}
                  onClick={() => setPeriod(item.value)}
                  className={`rounded-[8px] px-3.5 text-[13px] ${period === item.value ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink-2 hover:text-ink'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <Link
              to="/reports"
              className="inline-flex h-9 items-center rounded-[10px] border border-line-2 bg-white px-4 text-[13.5px] font-medium text-ink hover:border-brand-400 hover:text-brand-700"
            >
              报告管理
            </Link>
            <Link
              to="/eval-tasks"
              className="inline-flex h-9 items-center rounded-[10px] bg-gradient-to-b from-brand-500 to-brand-600 px-4 text-[13.5px] font-semibold text-white shadow-btn hover:from-brand-600 hover:to-brand-700"
            >
              评估任务
            </Link>
          </>
        }
      />

      {isAllTenants && (
        <section
          data-testid="tenant-overview"
          className="mb-5 rounded-card border border-line bg-white p-4 shadow-card"
        >
          <h2 className="mb-3 text-sm font-semibold text-ink">各租户概况</h2>
          <table className="w-full text-left text-[13px] text-ink-2">
            <thead className="text-xs text-ink-3">
              <tr>
                <th className="pb-2 font-medium">租户</th>
                <th className="pb-2 font-medium">评估对象</th>
                <th className="pb-2 font-medium">终端</th>
                <th className="pb-2 font-medium">任务</th>
                <th className="pb-2 font-medium">风险数（高危）</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-t border-line">
                  <td className="py-2">
                    <button
                      type="button"
                      data-testid={'tenant-overview-' + t.id}
                      className="font-medium text-brand-700 hover:underline"
                      onClick={() => enterTenant(t.id, '/')}
                    >
                      {t.name}
                    </button>
                  </td>
                  <td className="py-2">{t.targetCount}</td>
                  <td className="py-2">{t.endpointCount}</td>
                  <td className="py-2">{t.taskCount}</td>
                  <td className="py-2">
                    {t.riskCount ?? 0}（{t.highRiskCount ?? 0}）
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {!canReadTasks ? (
        <>
          <QueryState
            isLoading={false}
            isError={false}
            empty={false}
            permissionDenied
            emptyTitle="暂无数据"
            emptyDescription="发起评估后在此展示态势概览。"
          />
          {detectRiskCard && <div className="mt-4">{detectRiskCard}</div>}
          <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <QuickLaunch />
            {canReadAssurance && (
              <ComponentSecurityCard
                data={componentSecurity.isSuccess ? componentSecurity.data : undefined}
                state={loadState(componentSecurity)}
              />
            )}
          </div>
        </>
      ) : (
        <div className="space-y-4">
          {/* 综合卡与「需要你处理」上下排：宽屏并排时列表比综合卡高，综合卡下半会空出一大块。 */}
          <div className="grid gap-4">
            <PostureHero
              posture={po}
              postureState={loadState(posture)}
              changes={changes.data}
              range={period}
              stats={heroStats}
              links={{
                tasks: taskListHref(),
                findings: canDispose ? riskListHref({ since: po?.periodStart }) : undefined,
                targets: canReadTargets ? '/model-targets' : undefined,
                samples: canReadQuestions ? '/question-sets' : undefined,
                tools: hasPermission('tool:read') ? '/tools' : undefined,
              }}
            />
            <ActionList
              state={todoState}
              inputs={{
                highCount: po ? po.facts.highCount : null,
                highTaskCount: (ov?.topHighRiskTasks ?? []).filter((t) => t.highRiskCount > 0)
                  .length,
                reviewCount: td ? td.review.count : null,
                remediationCount: td ? td.remediation.count : null,
                connectionCount: td ? td.connection.count : null,
                untestedCount: ov?.connectionIssues ? ov.connectionIssues.untestedCount : null,
                targetCount: canReadTargets && ov ? ov.counts.modelTargetCount : null,
                gateCount: td ? (td.gates.planning ? td.gate.count : null) : null,
                gateVisible: showGate,
                modelFileCount,
                canDispose,
                periodLabel: label,
              }}
            />
          </div>

          {detectRiskCard}

          <section
            aria-label="我的待办"
            className={`grid gap-4 sm:grid-cols-2 ${showGate ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}
          >
            <KpiCard
              icon={<Eye />}
              title="待复核"
              tone="high"
              value={td ? td.review.count : null}
              loading={kpiLoading}
              error={todos.isError}
              onRetry={() => void todos.refetch()}
              to="/my-todos"
              zeroText="已清零"
              detail={
                // 待复核是全库存量，不随上方「统计周期」变化，卡片上写明范围。
                sparkPoints.length > 1 ? (
                  <span className="whitespace-nowrap">
                    全部时间 · 近 {sparkPoints.length} 天新增走势
                  </span>
                ) : (
                  <span className="whitespace-nowrap">全部时间 · 未复核 + 待人工复核</span>
                )
              }
              spark={
                sparkPoints.length > 1 ? (
                  <Sparkline
                    points={sparkPoints}
                    color="#B04A05"
                    hint="当日新增且仍待复核"
                    unit="条"
                  />
                ) : undefined
              }
            />
            <KpiCard
              icon={<Clock3 />}
              title="待整改到期"
              tone="high"
              value={td ? td.remediation.count : null}
              loading={kpiLoading}
              error={todos.isError}
              onRetry={() => void todos.refetch()}
              to="/my-todos"
              zeroText="已清零"
              detail="全部时间 · 整改临期或已逾期"
            />
            <KpiCard
              icon={<Unplug />}
              title="接入异常"
              tone="critical"
              value={td ? td.connection.count : null}
              loading={kpiLoading}
              error={todos.isError}
              onRetry={() => void todos.refetch()}
              to="/my-todos"
              zeroText="均正常"
              detail="全部时间 · 评估对象连通性未通过"
            />
            {showGate && td && (
              <KpiCard
                icon={<ShieldAlert />}
                title="门禁未过"
                tone="critical"
                value={td.gate.count}
                to="/eval/gates"
                zeroText="无阻断"
                detail="未通过的上线门禁"
              />
            )}
          </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_380px]">
            <TrendChart
              trend={trend.data}
              state={loadState(trend)}
              dayHref={canDispose ? dayRiskHref : undefined}
            />
            <RiskDistribution
              counts={sev}
              periodLabel={label}
              state={loadState(posture)}
              levelHref={
                canDispose
                  ? (severity) => riskListHref({ severity, since: po?.periodStart })
                  : undefined
              }
            />
          </div>

          <div
            data-testid="category-row"
            className={`grid gap-4 ${showRadar ? 'xl:grid-cols-2' : ''}`}
          >
            <CategoryTop
              data={categories.data}
              periodLabel={label}
              state={loadState(categories)}
              categoryHref={categoryHref}
            />
            <CategoryRadar
              data={categories.data}
              periodLabel={label}
              state={loadState(categories)}
              categoryHref={categoryHref}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <TopTasks tasks={ov?.topHighRiskTasks} state={loadState(overview)} />
            <RuleLibraryCard
              stats={ruleLibrary.data}
              state={loadState(ruleLibrary)}
              canReadQuestionSets={canReadQuestions}
              canReadAgentSamples={canReadTargets}
            />
          </div>

          <TaskWorklist
            rows={ov?.readiness}
            connectionIssueCount={connectionIssueCount}
            state={loadState(overview)}
          />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <QuickLaunch />
            {canReadAssurance && (
              <ComponentSecurityCard
                data={componentSecurity.isSuccess ? componentSecurity.data : undefined}
                state={loadState(componentSecurity)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
