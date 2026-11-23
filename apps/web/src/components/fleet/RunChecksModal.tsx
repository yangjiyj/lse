import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type FleetEndpoint } from '@/lib/api';
import {
  FLEET_LIVE_PRODUCTS,
  type FleetLiveProduct,
  type LiveRiskType,
} from '../../../../../packages/shared/src/fleet-live-eval';
import { LIVE_EVAL_UNAVAILABLE_HINT } from '@/lib/fleet';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { useToast } from '@/components/ui/toast';
import type { RuntimeSuite } from '../../../../../packages/shared/src/runtime-eval';
import { RuntimeEvalOptions, SuiteSelect } from './RuntimeEvalOptions';
import {
  RUNTIME_PRODUCT,
  defaultRuntimeForm,
  runtimeBlockedReason,
  runtimeErrorMessage,
  runtimeFormValid,
  runtimeV2Reported,
  startRuntimeJob,
} from './runtime-eval-form';

export type CheckMode = 'all' | 'posture' | 'live';
const toggle = <T,>(values: T[], value: T) =>
  values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
const pill =
  'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50 has-[:checked]:text-brand-700';

export function RunChecksModal({
  endpoint,
  onClose,
  initialMode = 'all',
  liveBlockedReason,
  onStarted,
}: {
  endpoint: FleetEndpoint | null;
  onClose: () => void;
  initialMode?: CheckMode;
  liveBlockedReason?: string;
  onStarted?: (taskId: string | null) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const catalog = useQuery({
    queryKey: ['fleet', 'check-catalog'],
    queryFn: () => api.fleet.checkCatalog(),
    enabled: !!endpoint,
    retry: false,
  });
  const overview = useQuery({
    queryKey: ['fleet', 'overview', endpoint?.id],
    queryFn: () => api.fleet.overview(endpoint!.id),
    enabled: !!endpoint,
    retry: false,
  });
  const [postureEnabled, setPostureEnabled] = useState(initialMode !== 'live');
  const [adjustPosture, setAdjustPosture] = useState(false);
  const [posture, setPosture] = useState<string[]>([]);
  const [live, setLive] = useState(initialMode === 'live');
  const [products, setProducts] = useState<string[]>([]);
  const [risks, setRisks] = useState<LiveRiskType[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [suite, setSuite] = useState<RuntimeSuite>('classic');
  const [runtimeForm, setRuntimeForm] = useState(defaultRuntimeForm);
  const [runtimeAck, setRuntimeAck] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const [postureTaskId, setPostureTaskId] = useState<string | null>(null);
  const [startedTasks, setStartedTasks] = useState<string[]>([]);
  // 用引用即时记录成功，部分失败重试不重复创建已成功任务。
  const completed = useRef(new Map<string, string | null>());
  const initializedCatalog = useRef(false);
  const initializedAgents = useRef(false);
  useEffect(() => {
    completed.current.clear();
    initializedCatalog.current = false;
    initializedAgents.current = false;
    setPostureEnabled(initialMode !== 'live');
    setLive(initialMode === 'live' && !!endpoint?.evalRunner);
    setPosture([]);
    setAdjustPosture(false);
    setProducts([]);
    setRisks([]);
    setConfirmed(false);
    setSuite('classic');
    setRuntimeForm(defaultRuntimeForm());
    setRuntimeAck(false);
    setRuntimeNotice('');
    setDone(false);
    setPostureTaskId(null);
    setStartedTasks([]);
    setReason('');
  }, [endpoint?.id, initialMode]);
  useEffect(() => {
    if (!endpoint || !catalog.data || initializedCatalog.current) return;
    initializedCatalog.current = true;
    setPosture(catalog.data.posture.map((c) => c.id));
    setRisks(catalog.data.liveRiskTypes?.map((r) => r.id) ?? []);
  }, [catalog.data, endpoint?.id]);
  const agents = (overview.data?.agents ?? []).filter(
    (a) => a.liveEval.supported && FLEET_LIVE_PRODUCTS.includes(a.key as FleetLiveProduct),
  );
  const available = agents.filter((a) => a.liveEval.registered);
  useEffect(() => {
    if (!endpoint || !overview.data || initializedAgents.current) return;
    initializedAgents.current = true;
    setProducts(
      overview.data.agents
        .filter(
          (a) =>
            a.liveEval.supported &&
            a.liveEval.registered &&
            FLEET_LIVE_PRODUCTS.includes(a.key as FleetLiveProduct),
        )
        .map((a) => a.key),
    );
  }, [overview.data, endpoint?.id]);
  const blocked =
    endpoint?.status === 'REVOKED'
      ? '该终端已吊销，无法发起检测或真机测评。'
      : liveBlockedReason || (!endpoint?.evalRunner ? LIVE_EVAL_UNAVAILABLE_HINT : '');
  const chosenProducts = products.filter((p) => available.some((a) => a.key === p));
  // 运行态测评只对已勾选且终端上报 runtimeV2 的 Claude Code 开放；不满足时按经典套件处理。
  const runtimeBlocked = runtimeBlockedReason(
    chosenProducts,
    runtimeV2Reported(endpoint?.agents, overview.data?.agents),
  );
  const runtimeOn = live && suite === 'runtime_v2' && !runtimeBlocked;
  const otherProducts = chosenProducts.filter((p) => p !== RUNTIME_PRODUCT);
  const scenarioCount =
    (catalog.data?.liveRiskTypes ?? [])
      .filter((r) => risks.includes(r.id))
      .reduce((n, r) => n + r.scenarioIds.length, 0) * chosenProducts.length;
  const frozen = completed.current.size > 0;
  const submit = useMutation({
    mutationFn: async () => {
      let lastTask: string | null = null;
      if (postureEnabled && posture.length) {
        if (!completed.current.has('posture')) {
          const result = await api.fleet.postureEval(endpoint!.id, { items: posture });
          completed.current.set('posture', result.taskId);
          setPostureTaskId(result.taskId);
          toast.success('已开始配置检测');
        }
        lastTask = completed.current.get('posture') ?? null;
      }
      if (live) {
        // 运行态测评只对 Claude Code 运行；其他已勾选的智能体本次不下发。
        for (const product of runtimeOn ? [RUNTIME_PRODUCT] : chosenProducts) {
          if (!completed.current.has(product)) {
            let taskId: string | null;
            if (runtimeOn) {
              const started = await startRuntimeJob(endpoint!.id, runtimeForm, reason.trim());
              taskId = started.taskId;
              setRuntimeNotice(started.text);
              toast.success(started.text);
            } else {
              const result = await api.fleet.requestEvalJob(endpoint!.id, {
                product: product as FleetLiveProduct,
                riskTypes: risks,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              });
              taskId = result.taskId ?? result.evalTaskId ?? null;
              toast.success('已下发真机测评，待终端领取（通常几十秒内）');
            }
            completed.current.set(product, taskId);
            setStartedTasks((prev) => [...prev, ...(taskId ? [taskId] : [])]);
          }
          lastTask = completed.current.get(product) ?? lastTask;
        }
      }
      return lastTask;
    },
    onSuccess: (taskId) => {
      setDone(true);
      void qc.invalidateQueries({ queryKey: ['fleet'] });
      onStarted?.(taskId);
    },
    onError: (err) => toast.error(runtimeErrorMessage(err, '检测发起失败，请稍后重试')),
  });
  const pending = submit.isPending;
  const change = (action: () => void) => {
    action();
    setConfirmed(false);
  };
  const time = overview.data?.report?.scannedAt;
  return (
    <div className="[&_[data-modal-dialog]]:max-w-[740px]">
      <Modal
        open={!!endpoint}
        onClose={pending ? () => {} : onClose}
        size="lg"
        title={`检测 ${endpoint?.hostname ?? ''}`}
        footer={
          <>
            {!done && (
              <span className="mr-auto self-center text-xs text-ink-3">
                配置体检 {postureEnabled ? posture.length : 0} 项 · 真机测评{' '}
                {runtimeOn ? '运行态（场景数提交后给出）' : `${live ? scenarioCount : 0} 个场景`}
              </span>
            )}
            <Button variant="outline" onClick={onClose} disabled={pending}>
              {done ? '关闭' : '取消'}
            </Button>
            {!done && (
              <Button
                onClick={() => submit.mutate()}
                disabled={
                  !catalog.data ||
                  !overview.data ||
                  pending ||
                  endpoint?.status === 'REVOKED' ||
                  (!postureEnabled && !live) ||
                  (postureEnabled && !posture.length) ||
                  (live &&
                    (!confirmed ||
                      !chosenProducts.length ||
                      !!blocked ||
                      (runtimeOn ? !runtimeAck || !runtimeFormValid(runtimeForm) : !risks.length)))
                }
              >
                {pending ? '提交中…' : '开始检测'}
              </Button>
            )}
          </>
        }
      >
        {catalog.isLoading || overview.isLoading ? <p role="status">正在加载检测项目…</p> : null}
        {(catalog.isError || overview.isError) && (
          <div role="alert">
            检测项目加载失败，请重试。
            <Button
              variant="outline"
              onClick={() => {
                void catalog.refetch();
                void overview.refetch();
              }}
            >
              重试
            </Button>
          </div>
        )}
        {catalog.data && !done && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-line p-3 has-[:checked]:border-brand-500 has-[:checked]:ring-2 has-[:checked]:ring-brand-50">
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 font-semibold">
                    <input
                      type="checkbox"
                      aria-label="配置体检"
                      checked={postureEnabled}
                      disabled={pending || frozen}
                      onChange={(e) => setPostureEnabled(e.target.checked)}
                    />
                    配置体检
                  </label>
                  <button
                    type="button"
                    className="text-xs font-normal text-brand-700 hover:underline"
                    aria-expanded={adjustPosture}
                    aria-controls="posture-items"
                    disabled={!postureEnabled || pending || frozen}
                    onClick={() => setAdjustPosture((value) => !value)}
                  >
                    调整
                  </button>
                </div>
                <p className="ml-5 mt-2 text-xs text-ink-3">只读 · 立即出结果</p>
                <p className="ml-5 mt-1 text-xs text-ink-3">
                  {time
                    ? `依据 ${new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 的最近一次上报`
                    : '终端尚未上报配置'}
                </p>
              </div>
              <label className="rounded-xl border border-line p-3 has-[:checked]:border-brand-500 has-[:checked]:ring-2 has-[:checked]:ring-brand-50">
                <span className="flex items-center gap-2 font-semibold">
                  <input
                    type="checkbox"
                    aria-label="启用真机测评"
                    checked={live}
                    disabled={!!blocked || pending || frozen}
                    onChange={(e) => change(() => setLive(e.target.checked))}
                  />
                  真机测评
                </span>
                <p className="ml-5 mt-2 text-xs text-ink-3">
                  {runtimeOn
                    ? '在终端的一次性沙箱里运行智能体 · 场景数提交后给出'
                    : `在终端上运行智能体 · ${scenarioCount} 个场景约 ${Math.max(1, Math.ceil(scenarioCount / 2))} 分钟`}
                </p>
                <p
                  className="ml-5 mt-1 truncate text-xs text-ink-3"
                  title={catalog.data.liveSummary.consumesQuota}
                >
                  消耗模型额度
                </p>
              </label>
            </div>
            {blocked && <p className="text-xs text-ink-3">{blocked}</p>}
            {postureEnabled && adjustPosture && (
              <fieldset id="posture-items" disabled={pending || frozen}>
                <legend className="mb-1 text-xs text-ink-3">配置项目</legend>
                <div className="flex flex-wrap gap-2">
                  {catalog.data.posture.map((item) => (
                    <label
                      key={item.id}
                      className={pill}
                      title={`${item.what}；${item.why}；${item.impact.note}`}
                    >
                      <input
                        type="checkbox"
                        aria-label={item.title}
                        checked={posture.includes(item.id)}
                        onChange={() => setPosture((prev) => toggle(prev, item.id))}
                      />
                      {item.title}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {live && (
              <>
                <fieldset
                  disabled={pending || frozen}
                  aria-labelledby="live-agents"
                  className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-3"
                >
                  <span id="live-agents" className="pt-1 text-xs text-ink-3">
                    智能体
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {agents.map((agent) => (
                      <label
                        key={agent.key}
                        className={`${pill} ${!agent.liveEval.registered ? 'border-dashed bg-slate-50 text-slate-400' : ''}`}
                        title={agent.liveEval.reason || undefined}
                      >
                        <input
                          type="checkbox"
                          aria-label={agent.name}
                          disabled={!agent.liveEval.registered}
                          checked={chosenProducts.includes(agent.key)}
                          onChange={() =>
                            change(() => setProducts((prev) => toggle(prev, agent.key)))
                          }
                        />
                        {agent.name}
                      </label>
                    ))}
                  </div>
                  {!agents.length && (
                    <p className="col-start-2 mt-2 text-xs text-ink-3">
                      终端尚未上报智能体清单，请更新探针并等待上报后再试。
                    </p>
                  )}
                  {!!agents.length && !available.length && (
                    <p className="col-start-2 mt-2 text-xs text-ink-3">
                      {agents.find((a) => a.liveEval.reason)?.liveEval.reason ||
                        '尚未上报智能体登记信息，请更新探针，并由终端管理员登记允许测评的智能体后等待上报。'}
                    </p>
                  )}
                </fieldset>
                <SuiteSelect
                  value={runtimeOn ? 'runtime_v2' : 'classic'}
                  onChange={(next) => change(() => setSuite(next))}
                  blockedReason={runtimeBlocked}
                  disabled={pending || frozen}
                />
                {runtimeOn ? (
                  <>
                    {!!otherProducts.length && (
                      <p className="text-xs text-ink-3">
                        运行态测评只测 Claude Code，其余已勾选的智能体本次不会下发。
                      </p>
                    )}
                    <RuntimeEvalOptions
                      value={runtimeForm}
                      onChange={(next) => change(() => setRuntimeForm(next))}
                      ack={runtimeAck}
                      onAck={setRuntimeAck}
                      disabled={pending || frozen}
                    />
                  </>
                ) : (
                  <fieldset
                    disabled={pending || frozen}
                    aria-labelledby="live-risks"
                    className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-3"
                  >
                    <span id="live-risks" className="pt-1 text-xs text-ink-3">
                      风险类型
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {catalog.data.liveRiskTypes?.map((risk) => (
                        <label
                          key={risk.id}
                          className={pill}
                          title={`${risk.what}；${risk.howJudged}`}
                        >
                          <input
                            type="checkbox"
                            aria-label={risk.label}
                            checked={risks.includes(risk.id)}
                            onChange={() => change(() => setRisks((prev) => toggle(prev, risk.id)))}
                          />
                          {risk.label}
                          <sup>{risk.scenarioIds.length}</sup>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
                <NoteBox tone="warning" className="flex items-center gap-3 px-3 py-2">
                  <p className="min-w-0 flex-1 text-xs leading-5">
                    {catalog.data.liveSummary.consumesQuota.match(
                      /^[^。！？.!?]+[。！？.!?]?/,
                    )?.[0] ?? catalog.data.liveSummary.consumesQuota}{' '}
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      title={`${catalog.data.liveSummary.consumesQuota}
${catalog.data.liveSummary.cleanup}
执行范围：${catalog.data.liveSummary.isolationNote}`}
                    >
                      说明
                    </button>
                  </p>
                  <label className="flex max-w-[280px] shrink-0 items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      aria-label="我已了解以上影响"
                      checked={confirmed}
                      disabled={pending || frozen}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    我已了解：将在终端上运行智能体并消耗模型额度
                  </label>
                </NoteBox>
              </>
            )}
            <label className="flex items-center gap-3 text-xs text-ink-3">
              备注
              <Input
                aria-label="备注"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                disabled={pending || frozen}
                className="flex-1"
              />
            </label>
          </div>
        )}
        {(done || completed.current.size > 0) && (
          <div role="status" className="mt-4 space-y-2 text-sm">
            {completed.current.has('posture') && <p>配置检测已开始。</p>}
            {[...completed.current.keys()].some((k) => k !== 'posture') && (
              <p>{runtimeNotice || '真机测评已下发，待终端领取。'}</p>
            )}
            <Link
              className="text-brand-700 underline"
              to={
                startedTasks[0]
                  ? `/eval-tasks/${startedTasks[0]}`
                  : postureTaskId
                    ? `/eval-tasks/${postureTaskId}`
                    : '/fleet?tab=jobs'
              }
            >
              去看进度
            </Link>
            {startedTasks.slice(1).map((id, i) => (
              <Link key={id} className="ml-3 text-brand-700 underline" to={`/eval-tasks/${id}`}>
                测评任务 {i + 2}
              </Link>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
