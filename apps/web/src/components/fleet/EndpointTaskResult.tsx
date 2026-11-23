import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, type EvalTaskDetail } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { FLEET_ENROLL_PATH, LIVE_EVAL_HOW_TO_ENABLE } from '@/lib/fleet';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { SensitiveText } from '@/components/SensitiveText';
import { EndpointOverviewLists } from './EndpointOverviewLists';
import { postureTaskOverview } from './posture-task-overview';
import { LiveResultsTable } from './LiveResultsTable';
import {
  AgentInventoryCard,
  EndpointConclusion,
  LiveScenarioCard,
  type SafetyState,
} from './safety/EndpointSafety';
import { Card } from '@/components/ui/card';

function time(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '终端尚未上报';
}

/** 终端配置检查与真机测评的管理员视图，未知与执行异常不会记为通过。 */
export function EndpointTaskResult({ task }: { task: EvalTaskDetail }) {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const running = task.status === 'PENDING' || task.status === 'RUNNING';
  const summary = useQuery({
    queryKey: ['endpoint-task-summary', task.id, task.status],
    queryFn: () => api.evalTasks.endpointSummary(task.id),
    refetchInterval: running ? 4000 : false,
  });
  const report = useMutation({
    mutationFn: () => api.reports.create({ taskId: task.id, kind: 'comprehensive' }),
    onSuccess: (result) => navigate(`/reports?taskId=${task.id}&reportId=${result.id}`),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : '报告生成失败，请稍后重试'),
  });
  const retest = useMutation({
    mutationFn: () => api.evalTasks.reEval(task.id),
    onSuccess: (result) => navigate(`/eval-tasks/${result.id}`),
    onError: (error) => toast.error(error instanceof Error ? error.message : '重新检测失败'),
  });
  const cancel = useMutation({
    mutationFn: () => api.evalTasks.cancel(task.id),
    onSuccess: () => toast.success('已请求停止检测'),
    onError: (error) => toast.error(error instanceof Error ? error.message : '停止检测失败'),
  });
  const data = summary.data;
  const live = data?.mode === 'live' || (!data?.mode && (data?.liveScenarios.length ?? 0) > 0);
  const newOutcomes = live && !!data?.liveScenarios.some((s) => s.outcome);
  return (
    <div className="space-y-5">
      <Button variant="ghost" onClick={() => navigate('/eval-tasks')}>
        返回任务列表
      </Button>
      <Card className="space-y-4 p-6">
        <h1 className="text-xl font-semibold">{task.name}</h1>
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div>
            <dt className="text-ink-3">被测电脑</dt>
            <dd>
              {data?.endpoint.name ||
                (summary.isError ? '终端信息暂时无法读取' : '正在读取终端信息…')}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">检测时间</dt>
            <dd>{time(task.startedAt || task.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-ink-3">终端最近上报</dt>
            <dd>
              {data
                ? time(data.endpoint.lastSeenAt)
                : summary.isError
                  ? '最近上报时间暂时无法读取'
                  : '正在读取上报时间…'}
            </dd>
          </div>
        </dl>
        {live &&
          !newOutcomes &&
          (data?.agents.length ? (
            <AgentInventoryCard
              agents={data.agents}
              title="被测智能体清单"
              versionSeparator=" · "
              mode={live ? 'live' : 'posture'}
              enableHint={
                live ? (
                  <p className="mt-1">
                    {LIVE_EVAL_HOW_TO_ENABLE}
                    <Link
                      className="ml-1 font-medium text-brand-700 hover:underline"
                      to={FLEET_ENROLL_PATH}
                    >
                      去终端接入页
                    </Link>
                  </p>
                ) : undefined
              }
            />
          ) : (
            <p className="text-sm">
              {data
                ? '终端尚未上报智能体清单，请更新探针并重新检测。'
                : summary.isError
                  ? '智能体清单暂时无法读取，请重试。'
                  : '正在读取智能体清单…'}
            </p>
          ))}
        {!newOutcomes && (
          <div role="status">
            <EndpointConclusion
              showState={false}
              verdictLine={
                data?.verdictLine ||
                (summary.isError
                  ? '检查结论暂时无法读取，请重试。'
                  : running
                    ? '检测正在进行，请等待终端返回结果。'
                    : '正在读取检查结论…')
              }
            />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {hasPermission('report:generate') && (
            <Button disabled={running || report.isPending || !data} onClick={() => report.mutate()}>
              {report.isPending ? '正在生成报告…' : '生成报告'}
            </Button>
          )}
          {hasPermission('eval_task:re_eval') && (
            <Button
              variant="outline"
              disabled={running || retest.isPending || !data}
              onClick={() =>
                live
                  ? navigate('/eval-tasks', {
                      state: {
                        endpointRetestTargetId: task.modelTarget?.id,
                        endpointRetestMode: 'run',
                      },
                    })
                  : retest.mutate()
              }
            >
              {live ? '重新选择真机测评范围' : '重新检测配置'}
            </Button>
          )}
          {hasPermission('eval_task:delete') && running && (
            <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              停止检测
            </Button>
          )}
        </div>
        {live && !newOutcomes && (
          <p className="text-xs text-ink-3">
            再次测评会重新打开参数和影响确认；不会直接在终端运行。
          </p>
        )}
      </Card>
      {summary.isLoading && <p>正在读取终端检测结果…</p>}
      {summary.isError && (
        <div role="alert">
          终端结果暂时无法读取，不能据此判断安全。
          <Button variant="outline" onClick={() => void summary.refetch()}>
            重新读取
          </Button>
        </div>
      )}
      {data && !live && (
        <EndpointOverviewLists overview={data.overview ?? postureTaskOverview(data)} />
      )}
      {data && newOutcomes && (
        <LiveResultsTable
          summary={data}
          taskId={task.id}
          running={running}
          targetId={task.modelTarget?.id}
        />
      )}
      {!!data?.liveScenarios.length && !newOutcomes && (
        <section className="space-y-3">
          <h2 className="font-semibold">真机场景与证据</h2>
          {data.liveScenarios.map((scenario, i) => (
            <LiveScenarioCard
              key={`${scenario.scenarioId}-${i}`}
              title={`场景 ${i + 1}`}
              scenario={scenario}
              state={(scenario as typeof scenario & { state?: SafetyState }).state}
              renderText={(value) => (
                <SensitiveText
                  field="eval-tasks.endpoint-summary"
                  targetType="eval_task"
                  targetId={task.id}
                  text={value || '终端尚未返回该项信息，请检查执行记录并重新测评。'}
                />
              )}
            />
          ))}
        </section>
      )}
    </div>
  );
}
