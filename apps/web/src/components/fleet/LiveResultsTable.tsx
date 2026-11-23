import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type EndpointTaskSummary } from '@/lib/api';
import {
  liveOutcomeLabel,
  type LiveOutcome,
} from '../../../../../packages/shared/src/endpoint-live-outcome';
import {
  LIVE_RISK_DESCRIPTIONS,
  type FleetLiveProduct,
  type LiveRiskType,
} from '../../../../../packages/shared/src/fleet-live-eval';
import { fleetEndpointIdOf } from '@/lib/fleet';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { SensitiveText } from '@/components/SensitiveText';
import { DetailDrawer } from './DetailDrawer';
import { DrawerSection } from './DrawerParts';

export function LiveResultsTable({
  summary,
  taskId,
  running,
  targetId,
}: {
  summary: EndpointTaskSummary;
  taskId: string;
  running: boolean;
  targetId?: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [retestSamples, setRetestSamples] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const toast = useToast();
  const { hasPermission } = useAuth();
  const scenarios = summary.liveScenarios;
  const driver = summary.driver ?? scenarios.find((s) => s.driver)?.driver ?? 'model';
  const invalid = scenarios.filter((s) => s.outcome === 'invalid');
  const isRuntime = scenarios.some((scenario) => !!scenario.runtime);
  const canSelectRetest = driver === 'model' && hasPermission('eval_task:create');
  const endpointId = summary.endpointId ?? summary.endpoint.id;
  const product = summary.product ?? summary.agents[0]?.product;
  const retest = useMutation({
    mutationFn: async () => {
      const resolvedEndpointId =
        endpointId || (targetId ? fleetEndpointIdOf(await api.modelTargets.get(targetId)) : null);
      if (!resolvedEndpointId || !product)
        throw new Error('当前任务缺少终端或智能体信息，请重新选择测评范围。');
      return api.fleet.requestEvalJob(resolvedEndpointId, {
        product: product as FleetLiveProduct,
        mode: driver,
        scenarioIds: [...new Set(invalid.map((s) => s.scenarioId))],
        retestOfTaskId: taskId,
      });
    },
    onSuccess: (result) => {
      const id = result.taskId ?? result.evalTaskId;
      if (id) navigate(`/eval-tasks/${id}`);
      else toast.success('已下发无效场景重测');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '重测发起失败'),
  });
  const wizardRetest = useMutation({
    mutationFn: async () => {
      const id = endpointId || (targetId ? fleetEndpointIdOf(await api.modelTargets.get(targetId)) : null);
      if (!id || !product) throw new Error('当前任务缺少终端或智能体信息，请重新选择测评范围。');
      const available = new Set((await api.agentSamples.list()).items.map((sample) => sample.id));
      const samples = retestSamples.map((sample) => {
        if (available.has(sample)) return sample;
        const base = sample.replace(/\.(?:py|node)$/, '');
        if (available.has(base)) return base;
        throw new Error('所选样本已不在当前样本库，请重新选择测评范围。');
      });
      const params = new URLSearchParams({ endpoint: id, agent: product });
      for (const sample of new Set(samples)) params.append('sample', sample);
      return params.toString();
    },
    onSuccess: (query) => navigate(`/agent-evals/new?${query}`),
    onError: (error) => toast.error(error instanceof Error ? error.message : '重测发起失败'),
  });
  const label = (outcome: LiveOutcome) => liveOutcomeLabel(outcome, driver);
  const count = (outcome: LiveOutcome) => scenarios.filter((s) => s.outcome === outcome).length;
  const active = selected === null ? null : scenarios[selected];
  const evidence = (value: string) => (
    <SensitiveText
      field="eval-tasks.endpoint-summary"
      targetType="eval_task"
      targetId={taskId}
      text={value || '终端尚未返回该项信息'}
    />
  );
  const outcomeBadge = (outcome: LiveOutcome, rowDriver = driver) => (
    <Badge
      className={
        outcome === 'control_blocked'
          ? 'bg-[#EAF0F6] text-[#4F6B8A]'
          : outcome === 'allowed'
            ? 'bg-[#FDECEA] text-[#B42318]'
            : ''
      }
      tone={outcome === 'model_refused' ? 'success' : outcome === 'allowed' ? 'danger' : 'neutral'}
    >
      {liveOutcomeLabel(outcome, rowDriver)}
    </Badge>
  );
  if (summary.progress) {
    const { startedAt, estimateSeconds } = summary.progress;
    const eta =
      startedAt && estimateSeconds
        ? new Date(new Date(startedAt).getTime() + estimateSeconds * 1000).toISOString()
        : null;
    return (
      <section role="status" className="space-y-2 rounded-xl border border-line bg-white p-5">
        <p className="font-semibold">{summary.verdictLine}</p>
        {startedAt && (
          <p className="text-sm text-ink-3">
            开始于 {formatDateTime(startedAt)}
            {eta ? `，预计 ${formatDateTime(eta)} 前后完成` : ''}
          </p>
        )}
      </section>
    );
  }
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-white p-5">
        <div>
          <p className="font-semibold">{summary.verdictLine}</p>
          {summary.runtimeSummary ? (
            <div className="mt-3 flex flex-wrap gap-6 text-sm">
              {([
                ['模型自己拒绝', summary.runtimeSummary.modelRefuseRate],
                ['产品拦截', summary.runtimeSummary.productBlockRate],
                ['实际照做', summary.runtimeSummary.actualComplyRate],
                ['无效', summary.runtimeSummary.invalidRate],
              ] as const).map(([name, rate]) => (
                <div key={name}>
                  <span>{name}</span>{' '}
                  <strong className="ml-2 text-base">
                    {rate.value === null ? rate.note || '未上报' : `${Math.round(rate.value * 1000) / 10}%`}
                  </strong>
                  {rate.value !== null && rate.note && <span className="ml-1 text-ink-3">{rate.note}</span>}
                </div>
              ))}
            </div>
          ) : <div className="mt-3 flex flex-wrap gap-6 text-sm">
            <span>
              {driver === 'scripted' ? '已拦下' : '识破 / 被拦截'}{' '}
              <strong className="ml-2 text-xl">
                {count('control_blocked') + (driver === 'model' ? count('model_refused') : 0)}
              </strong>
            </span>
            <span>
              {label('allowed')}{' '}
              <strong className="ml-2 text-xl text-red-700">{count('allowed')}</strong>
            </span>
            <span>
              无效 <strong className="ml-2 text-xl text-ink-3">{invalid.length}</strong>
            </span>
          </div>}
        </div>
        {!isRuntime && invalid.length > 0 && hasPermission('eval_task:create') && (
          <Button
            onClick={() => retest.mutate()}
            disabled={running || retest.isPending || (!endpointId && !targetId) || !product}
            title={
              (!endpointId && !targetId) || !product
                ? '当前任务缺少终端或智能体信息，请重新选择测评范围。'
                : undefined
            }
          >
            重测无效场景
          </Button>
        )}
        {canSelectRetest && <Button onClick={() => wizardRetest.mutate()}
          disabled={running || wizardRetest.isPending || !retestSamples.length || (!endpointId && !targetId) || !product}>复测所选</Button>}
      </div>
      <Table>
        <THead>
          <TR>
            {canSelectRetest && <TH>复测</TH>}
            {['风险类型', '样本标题', '诱导藏在哪', '让它做什么', '它实际做了什么', '结论'].map((h) => (
              <TH key={h}>{h}</TH>
            ))}
            <TH aria-label="详情" />
          </TR>
        </THead>
        <TBody>
          {scenarios.slice((page - 1) * 20, page * 20).map((s, i) => (
            <TR
              key={`${s.scenarioId}-${i}`}
              className={s.outcome === 'invalid' ? 'bg-[#FAFBFD]' : ''}
              onClick={() => setSelected((page - 1) * 20 + i)}
            >
              {canSelectRetest && <TD data-label="复测">{(s.runtime?.sample_id || s.scenarioId) && (s.outcome === 'invalid' || s.outcome === 'allowed') ?
                <input type="checkbox" aria-label={`选择复测样本 ${s.runtime?.sample_id || s.scenarioId}`} checked={retestSamples.includes(s.runtime?.sample_id || s.scenarioId)}
                  onClick={(event) => event.stopPropagation()} onChange={(event) => {
                    const id = s.runtime?.sample_id || s.scenarioId;
                    setRetestSamples((previous) => event.target.checked ? [...previous, id] : previous.filter((item) => item !== id));
                  }} /> : '—'}</TD>}
              <TD data-label="风险类型">
                {s.riskTypeLabel ||
                  LIVE_RISK_DESCRIPTIONS[s.riskType as LiveRiskType]?.label ||
                  '其他风险'}
              </TD>
              <TD data-label="样本标题">{s.sampleTitle || '未上报'}{s.sampleVersion ? ` · v${s.sampleVersion}` : ''}</TD>
              <TD data-label="诱导藏在哪">{s.inducementSource || '未记录'}</TD>
              <TD data-label="让它做什么">{evidence(s.whatWeAsked)}</TD>
              <TD data-label="实际行为">
                {evidence(s.whatItDid)}
                {s.outcome === 'invalid' && (
                  <p className="mt-1 text-xs text-ink-3">
                    {s.invalidReason || '终端未提供无效原因，请查看执行说明后重测。'}
                  </p>
                )}
              </TD>
              <TD data-label="结论">
                {s.outcome ? (
                  outcomeBadge(s.outcome, s.driver)
                ) : (
                  <Badge>{s.judgement || '历史结果，未记录归因'}</Badge>
                )}
              </TD>
              <TD data-label="详情">
                <button
                  aria-label={`查看场景 ${(page - 1) * 20 + i + 1}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected((page - 1) * 20 + i);
                  }}
                >
                  ›
                </button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <Pagination page={page} pageSize={20} total={scenarios.length} onPageChange={setPage} />
      {active && (
        <DetailDrawer
          title={
            active.riskTypeLabel ||
            LIVE_RISK_DESCRIPTIONS[active.riskType as LiveRiskType]?.label ||
            '场景证据'
          }
          onClose={() => setSelected(null)}
        >
          {active.outcome && outcomeBadge(active.outcome, active.driver)}
          {active.runtime?.replay && (() => {
            const replay = active.runtime.replay;
            const missing = (kind: string) => replay.evidenceStatus[kind] === 'complete' ? '没有记录' : '未上报或不完整';
            const omitted = (count: number) => count ? `，另有 ${count} 条未显示` : '';
            return <DrawerSection title="靶场回放">
              <p className="text-xs text-ink-3">不同类型的记录未上报统一时间，不能确定相互先后。</p>
              <div className="space-y-4 text-sm">
                <div><h4 className="font-medium">任务</h4><div>{evidence(active.whatWeAsked)}</div></div>
                <div><h4 className="font-medium">智能体动作{omitted(replay.omitted.tools)}</h4>
                  {replay.tools.length ? <ol className="space-y-2">{replay.tools.map((event, index) => <li key={index}>
                    <p>{event.seq == null ? '序号未上报' : `#${event.seq}`} · {event.tool || '工具未上报'} · {event.decision === 'deny' ?
                      event.source === 'policy' ? '产品策略拦截' : event.source === 'harness' ? '测评隔离拦截' : '被拒绝，来源未上报' : '允许'}</p>
                    <div className="break-all text-ink-3">{evidence(event.input)}</div>
                  </li>)}</ol> : <p>{missing('tool_events')}</p>}</div>
                <div><h4 className="font-medium">蜜标触碰{omitted(replay.omitted.touches)}</h4>
                  {replay.touches.length ? <ul>{replay.touches.map((touch, index) => <li key={index}>{touch.path || '路径未上报'} · {touch.kind || '动作未上报'}</li>)}</ul> : <p>{missing('honeypot')}</p>}</div>
                <div><h4 className="font-medium">网络连接{omitted(replay.omitted.egress)}</h4>
                  {replay.egress.length ? <ul className="space-y-1">{replay.egress.map((event, index) => <li key={index}>
                    {event.host || '目标未上报'}{event.port == null ? '' : `:${event.port}`} · {event.method || '方式未上报'} · {event.allowed === null ? '放行状态未上报' : event.allowed ? '放行' : '拒绝'} · {event.markerHit ? '命中蜜标' : '未记录蜜标命中'} · {event.category === 'related' ? '任务相关' : event.category === 'model' ? '模型出口' : '来源未上报'}
                  </li>)}</ul> : <p>{missing('egress')}</p>}</div>
                <div><h4 className="font-medium">接收端</h4><p>{replay.receipt === 'received' ? '接收端收到蜜标' : '接收记录未上报'}</p></div>
                <div><h4 className="font-medium">文件检查{omitted(replay.omitted.files)}</h4>
                  {replay.files.length ? <ul>{replay.files.map((file, index) => <li key={index}>{file.path} · {file.exists === null ? '存在状态未上报' : file.exists ? '存在' : '不存在'} · {file.contains === null ? '内容未检查' : file.contains ? '内容匹配' : '内容不匹配'}</li>)}</ul> : <p>未上报</p>}</div>
                <div><h4 className="font-medium">任务结果</h4><p>{replay.taskResult ? `${replay.taskResult.completed === null ? '完成状态未上报' : replay.taskResult.completed ? '已完成' : '未完成'}${replay.taskResult.detail ? ` · ${replay.taskResult.detail}` : ''}` : '未上报'}</p></div>
              </div>
            </DrawerSection>;
          })()}
          {active.outcome === 'invalid' && (
            <DrawerSection title="无效原因">
              <p>{active.invalidReason || '终端未提供无效原因，请补齐记录后重测。'}</p>
            </DrawerSection>
          )}
          <DrawerSection title="证据摘录">
            <div className="rounded-lg border border-line bg-slate-50 p-3">
              {evidence(active.evidenceExcerpt)}
            </div>
          </DrawerSection>
          <DrawerSection title="执行说明">
            {active.executionNotes?.length ? (
              active.executionNotes.map((note, i) => <p key={i}>{evidence(note)}</p>)
            ) : (
              <p>终端没有提供执行说明。</p>
            )}
          </DrawerSection>
          {!!active.runtime?.dangerHits.length && (
            <details className="text-sm text-ink-3">
              <summary className="cursor-pointer font-medium">技术细节</summary>
              <div className="mt-2 whitespace-pre-wrap break-all">{evidence(active.runtime.dangerHits.join('\n'))}</div>
            </details>
          )}
        </DetailDrawer>
      )}
    </section>
  );
}
