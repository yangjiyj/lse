import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type AgentSample, type AgentSampleDetail } from '@/lib/api';
import { DetailDrawer } from '@/components/fleet/DetailDrawer';
import { DrawerSection } from '@/components/fleet/DrawerParts';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';
import { FLEET_JOB_STATUS_LABELS } from '@/lib/fleet';
import { FLEET_LIVE_PRODUCT_LABELS, FLEET_LIVE_PRODUCTS, type FleetLiveProduct } from '../../../../../packages/shared/src/fleet-live-eval';
import { OutcomeBar, OutcomeLegend } from './OutcomeBar';
import { SampleTags } from './SampleTags';

export const TEMPLATE: Record<string, string> = { 'py-service-v1': 'Python 库存服务', 'node-api-v1': 'Node 订单接口', any: '两种项目' };
export const product = (value: string) => FLEET_LIVE_PRODUCT_LABELS[value as FleetLiveProduct] ?? value;
/** 只有被限制在个别智能体的样本才需要标注；支持全部智能体的不写。 */
export const restrictedAgents = (agents: string[]) =>
  agents.length > 0 && agents.length < FLEET_LIVE_PRODUCTS.length ? agents.map(product).join('、') : null;

const rate = (value: number | null) => (value === null ? '无有效运行' : `${Math.round(value * 1000) / 10}%`);
const shortDigest = (digest: string) => digest.replace(/^sha256:/, '').slice(0, 8);

function PoisonBlock({ block }: { block: AgentSampleDetail['poison'][number] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-slate-50 px-3 py-1.5 text-xs">
        {block.path && <span className="font-mono text-ink">{block.path}</span>}
        <span className="text-ink-3">{block.location}</span>
      </div>
      <pre className="whitespace-pre-wrap break-words bg-white px-3 py-2 font-mono text-xs leading-5 text-ink">{block.text}</pre>
    </div>
  );
}

function Provenance({ detail }: { detail: AgentSampleDetail }) {
  const p = detail.provenance;
  return (
    <dl className="mt-3 space-y-1.5 text-sm">
      {p.origin && <div className="flex gap-3"><dt className="w-14 shrink-0 text-ink-3">来源</dt><dd>{p.origin}</dd></div>}
      {(p.createdBy || p.kind === 'custom') && (
        <div className="flex gap-3"><dt className="w-14 shrink-0 text-ink-3">创建</dt><dd>{p.createdBy ? `${p.createdBy} · ` : ''}{formatDateTime(p.createdAt)}</dd></div>
      )}
      {p.changeNote && <div className="flex gap-3"><dt className="w-14 shrink-0 text-ink-3">变更</dt><dd>{p.changeNote}</dd></div>}
      <div className="flex gap-3"><dt className="w-14 shrink-0 text-ink-3">版本</dt><dd className="font-mono text-xs leading-5">{`v${p.version} · ${shortDigest(p.digest)}`}</dd></div>
    </dl>
  );
}

export function SampleDetails({ sample, close, showStart = true }: { sample: AgentSample; close: () => void; showStart?: boolean }) {
  const [version, setVersion] = useState<number | undefined>();
  const history = useQuery({ queryKey: ['agent-sample-history', sample.id], queryFn: () => api.agentSamples.exportSample(sample.id), enabled: showStart, retry: false });
  const query = useQuery({ queryKey: ['agent-sample', sample.id, version], queryFn: () => api.agentSamples.get(sample.id, version) });
  const statistics = useQuery({ queryKey: ['agent-sample-stats', sample.id], queryFn: () => api.agentSamples.statistics(sample.id), retry: false });
  const trials = useQuery({ queryKey: ['agent-sample-trials', sample.id, version], queryFn: () => api.agentSamples.trials(sample.id, version), enabled: showStart && sample.suite === 'runtime_v2', retry: false });
  const detail = query.data;
  const only = detail ? restrictedAgents(detail.agents) : null;
  const classic = sample.suite === 'classic';
  const expectLines = detail?.expect
    ? [
        ...(detail.expect.run ? [`运行 ${detail.expect.run.join(' ')} 应通过`] : []),
        ...(detail.expect.final_contains ?? []).map((item) => `回答应包含：${item}`),
        ...(detail.expect.files ?? []).map((item) => `${item.path} 应包含：${item.contains}`),
      ]
    : [];
  const query1 = version ? `&version=${version}` : '';
  return (
    <DetailDrawer title={detail?.title ?? sample.title} subtitle={<SampleTags item={detail ?? sample} />} onClose={close}>
      {query.isLoading && <LoadingBlock label="正在读取样本" />}
      {query.isError && <p role="alert">样本详情读取失败，请重试。</p>}
      {detail && <>
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3 text-sm">
          <div className="min-w-0"><p className="text-xs text-ink-3">样本编号</p><p className="break-all font-mono text-xs leading-5">{detail.id}</p></div>
          {detail.template && <div><p className="text-xs text-ink-3">靶场项目</p><p>{TEMPLATE[detail.template] ?? detail.template}</p></div>}
          {only && <div><p className="text-xs text-ink-3">适用智能体</p><p>仅 {only}</p></div>}
          {showStart && history.data?.samples[0] && (
            <label className="block text-xs text-ink-3">样本版本
              <Select aria-label="样本版本" className="mt-1" value={version ?? history.data.samples[0].currentVersion} onChange={(event) => setVersion(Number(event.target.value))}>
                {history.data.samples[0].versions.map((entry) => <option key={entry.version} value={entry.version}>v{entry.version} · {formatDateTime(entry.createdAt)}</option>)}
              </Select>
            </label>
          )}
        </div>

        <DrawerSection title="这条样本测什么"><p className="text-sm leading-6">{detail.summary}</p></DrawerSection>

        <DrawerSection title="毒藏在哪">
          {detail.poison.length
            ? <div className="space-y-2">{detail.poison.map((block, index) => <PoisonBlock key={`${block.location}-${index}`} block={block} />)}</div>
            : <p className="text-sm text-ink-3">直接写在给智能体的任务里，没有埋进文件。</p>}
        </DrawerSection>

        <DrawerSection title="给智能体的任务">
          <blockquote className="whitespace-pre-wrap border-l-2 border-brand-200 pl-3 text-sm leading-6">{detail.prompt}</blockquote>
          {detail.turns.map((turn, index) => <p key={index} className="mt-2 whitespace-pre-wrap border-l-2 border-brand-200 pl-3 text-sm leading-6"><span className="text-ink-3">第 {index + 1} 轮　</span>{turn}</p>)}
        </DrawerSection>

        <DrawerSection title="怎么判定照做">
          <ul className="list-disc space-y-1 pl-5 text-sm">{detail.dangerDescriptions.map((item, index) => <li key={index}>{item}</li>)}</ul>
          {detail.decoyInfo.length > 0 && (
            <ul className="mt-3 space-y-2">
              {detail.decoyInfo.map((decoy) => (
                <li key={decoy.id} className="rounded-lg border border-line px-3 py-2">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm"><span className="font-medium">{decoy.label}</span>{decoy.path && <code className="font-mono text-xs text-ink-2">{decoy.path}</code>}</p>
                  <p className="mt-0.5 text-xs text-ink-3">{decoy.purpose}</p>
                </li>
              ))}
            </ul>
          )}
        </DrawerSection>

        {expectLines.length > 0 && (
          <DrawerSection title="期望的正常结果"><ul className="list-disc space-y-1 pl-5 text-sm">{expectLines.map((line) => <li key={line}>{line}</li>)}</ul></DrawerSection>
        )}

        <DrawerSection title="出处与参考标准">
          {detail.refsInfo.length > 0 && <div className="flex flex-wrap gap-1.5">{detail.refsInfo.map((ref) => <span key={ref.code} className="rounded-md border border-line px-2 py-0.5 text-xs">{ref.label}</span>)}</div>}
          <Provenance detail={detail} />
        </DrawerSection>

        <DrawerSection title="运行统计">
          {statistics.isLoading ? <p role="status" className="text-sm">正在读取统计…</p>
            : statistics.isError ? <p className="text-sm">统计不可用或无查看权限。</p>
            : !statistics.data?.items.length ? <p className="text-sm text-ink-3">暂无运行记录。</p>
            : <>
              <ul className="space-y-4">{statistics.data.items.map((item) => (
                <li key={item.product} className="space-y-1.5">
                  <p className="text-sm font-medium">{product(item.product)}</p>
                  <OutcomeBar label={classic ? '运行结果' : '防护关'} counts={item.observe} />
                  {!classic && <OutcomeBar label="防护开" counts={item.enforce} />}
                  <p className="text-xs text-ink-2">{classic ? '' : '防护关下'}照做率 {rate(item.observe.complyRate)}</p>
                  {Object.values(item.unlabeled).some((value) => typeof value === 'number' && value > 0) && (
                    <OutcomeBar label="未标注" counts={item.unlabeled} />
                  )}
                </li>
              ))}</ul>
              <OutcomeLegend />
            </>}
          {!!statistics.data?.incompleteJobs && <p className="mt-2 text-xs text-ink-3">有 {statistics.data.incompleteJobs} 个任务读取失败，统计不完整。</p>}
          {!!statistics.data?.versions?.length && (
            <details className="mt-3 text-xs text-ink-2">
              <summary className="cursor-pointer text-brand-700">按版本查看</summary>
              <ul className="mt-2 space-y-1">{statistics.data.versions.map((item) => (
                <li key={`${item.product}-${item.version ?? 'unknown'}`}>
                  {product(item.product)} · {item.version === null ? '版本未记录' : `v${item.version}`}：防护关 照做 {item.observe.allowed} · 识破 {item.observe.model_refused} · 被拦截 {item.observe.control_blocked} · 无效 {item.observe.invalid}；防护开 照做 {item.enforce.allowed} · 识破 {item.enforce.model_refused} · 被拦截 {item.enforce.control_blocked} · 无效 {item.enforce.invalid}
                </li>
              ))}</ul>
            </details>
          )}
        </DrawerSection>

        {sample.suite === 'runtime_v2' && showStart && (
          <DrawerSection title="试运行记录">
            {trials.isLoading ? <p className="text-sm">正在读取试运行记录…</p> : trials.isError ? <p className="text-sm">试运行记录暂不可用。</p>
              : !trials.data?.items.length ? <p className="text-sm text-ink-3">暂无试运行记录。</p>
              : <ul className="space-y-2 text-sm">{trials.data.items.map((item) => (
                <li key={item.taskId}>
                  v{item.version} · {formatDateTime(item.createdAt)} · {item.status === 'UNKNOWN' ? '未记录' : FLEET_JOB_STATUS_LABELS[item.status]}
                  {item.conclusion && <p>{item.conclusion}</p>}
                  <Link className="text-brand-700 underline" to={`/eval-tasks/${encodeURIComponent(item.taskId)}`}>查看任务</Link>
                </li>
              ))}</ul>}
          </DrawerSection>
        )}

        {showStart && sample.enabled !== false && (
          <div className="flex flex-wrap gap-3 pt-1">
            {sample.suite === 'runtime_v2' && (
              <Link className="inline-flex min-h-9 items-center rounded-md border border-line px-4 font-medium" to={`/agent-evals/new?sample=${encodeURIComponent(detail.id)}${query1}&trial=1`}>试运行一次</Link>
            )}
            <Link className="inline-flex min-h-9 items-center rounded-md bg-brand-600 px-4 font-medium text-white hover:bg-brand-700" to={`/agent-evals/new?sample=${encodeURIComponent(detail.id)}${query1}`}>用这条样本发起测评</Link>
          </div>
        )}
      </>}
    </DetailDrawer>
  );
}
