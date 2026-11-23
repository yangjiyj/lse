import { usePlatformAppEnabled } from '@/lib/use-platform-app-enabled';
import { isContentEvalTarget, isEndpointEvalTarget } from '@/lib/eval-targets';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type EndpointInfo, type ModelTarget } from '@/lib/api';
import { isEndpointOnline, productLabel, supportsLiveEval } from '@/lib/endpoint-agents';
import {
  FLEET_ENROLL_PATH,
  LIVE_EVAL_HOW_TO_ENABLE,
  fleetEndpointIdOf,
  targetDisplayName,
} from '@/lib/fleet';
import { PRODUCT_NAME } from '@/lib/product-name';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { multimodalDisabledReason } from '@/pages/MultimodalEvalModal';

export type EvaluationPlanKind =
  | 'content'
  | 'standard'
  | 'agent'
  | 'mcp'
  | 'redteam'
  | 'regression'
  | 'comprehensive'
  | 'fanout'
  | 'trace'
  | 'multimodal'
  | 'endpoint-posture'
  | 'endpoint-run';
export const ENDPOINT_PLAN_KINDS = ['endpoint-posture', 'endpoint-run'] as const;
export const ENDPOINT_PLAN_BLOCKED_REASON =
  '终端智能体对象只支持「配置体检」和「运行态测评」，请选择模型 API 或应用 API 对象使用此方案。';
const ENDPOINT_ONLY_REASON = '请选择终端智能体对象。';

export type EvaluationLine = 'content' | 'agent' | 'endpoint';

/** 第一层：三条测评线，每张卡片一句话说明测什么、依据什么。 */
export const EVALUATION_LINES: {
  line: EvaluationLine;
  title: string;
  basis: string;
  description: string;
}[] = [
  {
    line: 'content',
    title: '大模型内容安全',
    basis: '依据 GB/T 45654',
    description: '测内容风险、拒答边界与敏感信息，对照附录 A 的 31 项风险。',
  },
  {
    line: 'agent',
    title: '智能体应用安全',
    basis: '参照在研强制国标（非现行）',
    description: '测工具调用、越权与高风险操作，对照在研国标公示的 8 项要求。',
  },
  {
    line: 'endpoint',
    title: '终端智能体安全',
    basis: '对照 TC260-PG-20266A',
    description: '测员工电脑上智能体的配置与运行行为，对照安全检查清单。',
  },
];

interface Plan {
  kind: EvaluationPlanKind;
  title: string;
  description: string;
  /** 只有模型 API 对象可用。 */
  modelOnly?: boolean;
  /** 对象类型不满足时的禁用原因（返回 null 表示可用）。 */
  blockedFor?: (target: ModelTarget) => string | null;
}

/** 第二层：每条线下的具体方案。 */
const LINE_PLANS: Record<EvaluationLine, Plan[]> = {
  content: [
    {
      kind: 'standard',
      title: '标准评估',
      description: '按 GB/T 45654 冻结本次样本与范围，显示专项指标及未测项。',
      modelOnly: true,
    },
    {
      kind: 'content',
      title: '题库抽测',
      description: '从内置或自有题库抽题，检查内容风险、拒答边界、敏感信息与提示注入。',
    },
    {
      kind: 'redteam',
      title: '多轮红队',
      description: 'AI对抗演练：攻击模型与评估模型协作，按对象响应逐轮调整攻击，保留停止原因与证据。',
      modelOnly: true,
    },
    {
      kind: 'multimodal',
      title: '多模态越狱',
      description: '把有害请求画进图片再发给视觉模型，检验它会不会被图片绕过安全限制。',
    },
  ],
  agent: [
    {
      kind: 'agent',
      title: '沙箱评估',
      description: '在沙箱里验证工具调用的权限边界，工具企图与真实执行分别留证。',
      modelOnly: true,
    },
    {
      kind: 'agent',
      title: '平台应用评估',
      description: '对接入的平台智能体应用跑场景样本：系统提示词泄露、知识库越权、网页间接注入等。',
      blockedFor: (t) => (t.targetType === 'PLATFORM_APP' ? null : '请选择平台应用对象。'),
    },
    {
      kind: 'mcp',
      title: 'MCP 专项',
      description: '用 MCP 专项样本库检验接入 MCP 工具的智能体，会不会被工具描述或返回内容诱导越权。',
    },
  ],
  endpoint: [
    {
      kind: 'endpoint-posture',
      title: '配置体检',
      description: '读取终端上智能体的真实配置并判定风险，不运行智能体，发起后立即出结果。',
    },
    {
      kind: 'endpoint-run',
      title: '运行态测评',
      description:
        '在终端的隔离工作区里运行真实智能体，评估其工具调用行为；下发后由终端自动领取并执行。',
    },
  ],
};

/** 专家与复测方案：不属于某一条线，勾选「显示专家方案」后出现。 */
const MORE_PLANS: Plan[] = [
  {
    kind: 'regression',
    title: '整改复测 / 样本回归',
    description: '复用已有样本；确认对象版本与原评估一致后执行。',
  },
  {
    kind: 'comprehensive',
    title: '综合评估',
    description: '自行组合多种测试，分别确认各模块条件与预算。',
    modelOnly: true,
  },
  {
    kind: 'fanout',
    title: '间接提示注入',
    description:
      '验证外部内容投毒，明确测试环境与真实执行证据；用于验证智能体安全护栏对间接提示注入的防护缺陷。',
    modelOnly: true,
  },
  {
    kind: 'trace',
    title: '导入外部轨迹',
    description: '导入脱敏运行轨迹；缺失的观测条件保持未知。',
  },
];

const PLAN_CARD_CLASS =
  'flex h-full flex-col items-start justify-start rounded-xl border border-line bg-white p-4 text-left transition hover:border-brand-400 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:bg-[#F7F9FD] disabled:opacity-60 disabled:hover:border-line disabled:hover:shadow-none';

const LINE_CARD_CLASS =
  'flex h-full flex-col items-start rounded-xl border-2 bg-white p-4 text-left transition hover:border-brand-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30';

export function EvaluationPlanSelector({
  targets,
  loading,
  failed,
  retry,
  onSelect,
}: {
  targets: ModelTarget[];
  loading: boolean;
  failed: boolean;
  retry: () => void;
  onSelect: (kind: EvaluationPlanKind, targetId: string) => void;
}) {
  const platformAppEnabled = usePlatformAppEnabled();
  const [targetId, setTargetId] = useState('');
  const [line, setLine] = useState<EvaluationLine>('content');
  const [expert, setExpert] = useState(false);
  const navigate = useNavigate();
  const endpointConfig = useQuery({
    queryKey: ['endpoint-evals-config'],
    queryFn: () => api.endpointEvals.config(),
    retry: false,
  });
  const endpointEnabled = endpointConfig.data?.enabled === true;
  const endpointTargets = targets.filter(
    (t) => isEndpointEvalTarget(t) && (endpointEnabled || !!fleetEndpointIdOf(t)),
  );
  const endpointList = useQuery({
    queryKey: ['endpoint-evals-endpoints', 'all'],
    queryFn: () => api.endpointEvals.endpoints(),
    enabled: endpointEnabled && endpointTargets.length > 0,
    retry: false,
  });
  const contentTargets = targets.filter((t) => isContentEvalTarget(t, platformAppEnabled));
  const available = [...contentTargets, ...endpointTargets];
  const target = available.find((t) => t.id === targetId);
  const isEndpoint = target ? isEndpointEvalTarget(target) : false;
  const model = target && (target.targetType ?? 'MODEL') === 'MODEL';
  const endpointOf = (t: ModelTarget): EndpointInfo | undefined =>
    endpointList.data?.find((e) => e.endpoint_id === t.accessConfig?.endpointId);
  const endpointProductOf = (t: ModelTarget): string => String(t.accessConfig?.product ?? '');
  const endpointLabel = (t: ModelTarget): string => {
    // 自管终端生成的对象不在智能体安全平台的终端列表里，别显示成「未知产品 · 状态未知」。
    if (fleetEndpointIdOf(t)) return `${targetDisplayName(t)} · ${PRODUCT_NAME}自管终端`;
    const e = endpointOf(t);
    const host = e?.hostname ?? String(t.accessConfig?.endpointLabel ?? '');
    const status = e ? (isEndpointOnline(e) ? '在线' : '离线') : '状态未知';
    return `${targetDisplayName(t)} · ${productLabel(endpointProductOf(t))} · ${host || '未知主机'} · ${status}`;
  };
  const endpoint = target && isEndpoint ? endpointOf(target) : undefined;
  const liveBlocked: string | null = !target
    ? null
    : fleetEndpointIdOf(target)
      ? null
      : !endpoint
        ? endpointList.isError
          ? '终端列表读取失败，无法确认该终端是否支持运行态测评。'
          : '在终端列表中没有找到该终端，请到「接入终端」查看它是否已接入。'
        : supportsLiveEval(endpoint, endpointProductOf(target))
          ? null
          : `该终端不支持运行态测评（缺少测评执行器，或该智能体不支持无界面运行），仅可做配置体检。${LIVE_EVAL_HOW_TO_ENABLE}`;
  const pickTarget = (id: string) => {
    setTargetId(id);
    const picked = available.find((t) => t.id === id);
    if (!picked) return;
    // 终端对象落到终端线，其余对象不停留在终端线。
    if (isEndpointEvalTarget(picked)) setLine('endpoint');
    else if (line === 'endpoint') setLine('content');
  };
  const blockedReason = (p: Plan): string | null => {
    const endpointKind = p.kind === 'endpoint-posture' || p.kind === 'endpoint-run';
    if (target && isEndpoint) {
      if (!endpointKind) return ENDPOINT_PLAN_BLOCKED_REASON;
      return p.kind === 'endpoint-run' ? liveBlocked : null;
    }
    if (endpointKind) return target ? ENDPOINT_ONLY_REASON : null;
    if (p.kind === 'multimodal')
      return target ? multimodalDisabledReason(target) : '请先在上方选择评估对象。';
    if (target && p.modelOnly && !model) return '该方案需要模型 API 对象。';
    if (target && p.blockedFor) return p.blockedFor(target);
    return null;
  };
  const renderPlan = (p: Plan) => {
    const blocked = blockedReason(p);
    return (
      <button
        type="button"
        key={p.title}
        disabled={!target || failed || blocked !== null}
        title={blocked ?? undefined}
        onClick={() => onSelect(p.kind, targetId)}
        className={PLAN_CARD_CLASS}
      >
        <span className="block text-[14px] font-bold text-ink">{p.title}</span>
        <span className="mt-1.5 block text-[13px] leading-5 text-ink-3">{p.description}</span>
        {blocked && (
          <span className="mt-1 block text-xs leading-5 text-severity-critical">{blocked}</span>
        )}
      </button>
    );
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div><p className="font-medium">终端智能体测评</p><p className="text-sm text-ink-3">选择已接入终端和智能体，直接发起测评。</p></div>
        <Button variant="outline" onClick={() => navigate('/agent-evals/new')}>终端智能体测评</Button>
      </div>
      <Field label="评估对象" hint="先选择对象，后续方案会沿用此选择。">
        <Select
          aria-label="本次评估对象"
          value={targetId}
          onChange={(e) => pickTarget(e.target.value)}
          disabled={loading}
        >
          <option value="">{loading ? '正在读取对象…' : '请选择评估对象'}</option>
          {contentTargets.some((t) => (t.targetType ?? 'MODEL') === 'MODEL') && (
            <optgroup label="模型 API">
              {contentTargets
                .filter((t) => (t.targetType ?? 'MODEL') === 'MODEL')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · 模型 API
                  </option>
                ))}
            </optgroup>
          )}
          {contentTargets.some((t) => (t.targetType ?? 'MODEL') !== 'MODEL') && (
            <optgroup label="应用 API">
              {contentTargets
                .filter((t) => (t.targetType ?? 'MODEL') !== 'MODEL')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · 应用 API
                  </option>
                ))}
            </optgroup>
          )}
          {endpointTargets.length > 0 && (
            <optgroup label="终端智能体">
              {endpointTargets.map((t) => (
                <option key={t.id} value={t.id}>
                  {endpointLabel(t)}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </Field>
      {failed && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl border border-severity-critical/25 bg-severity-critical-bg px-4 py-3 text-sm text-severity-critical"
        >
          对象读取失败。
          <Button variant="outline" onClick={retry}>
            重新读取
          </Button>
        </div>
      )}
      {!failed && !loading && available.length === 0 && (
        <p className="rounded-xl border border-severity-medium/25 bg-severity-medium-bg px-4 py-3 text-sm text-severity-medium">
          尚无可执行对象，请先在评估对象中完成接入。
        </p>
      )}
      {!failed && !loading && endpointEnabled && endpointTargets.length === 0 && (
        <NoteBox tone="info" className="flex flex-wrap items-center justify-between gap-3">
          <span>
            <strong className="text-ink">尚未发现可评估的终端智能体。</strong>
            已接入智能体安全平台的终端可直接登记为评估对象，用于员工电脑上 Claude Code / Codex
            的配置体检和运行态测评。
          </span>
          <Button variant="outline" size="sm" onClick={() => navigate(FLEET_ENROLL_PATH)}>
            查看终端
          </Button>
        </NoteBox>
      )}
      <Field label="测评线">
        <div role="group" aria-label="测评线" className="grid gap-3 sm:grid-cols-3">
          {EVALUATION_LINES.map((l) => {
            const active = line === l.line;
            return (
              <button
                type="button"
                key={l.line}
                aria-pressed={active}
                data-line={l.line}
                onClick={() => setLine(l.line)}
                className={`${LINE_CARD_CLASS} ${
                  active ? 'border-brand-600 bg-brand-50/60' : 'border-line'
                }`}
              >
                <span className="block text-[15px] font-bold text-ink">{l.title}</span>
                <span className="mt-0.5 block text-xs font-semibold text-brand-600">{l.basis}</span>
                <span className="mt-1.5 block text-[13px] leading-5 text-ink-3">{l.description}</span>
              </button>
            );
          })}
        </div>
      </Field>
      {endpoint && !isEndpointOnline(endpoint) && (
        <NoteBox tone="warning">该终端已超过 24 小时未上线，结果可能不是最新状态。</NoteBox>
      )}
      <div
        role="group"
        aria-label={`${EVALUATION_LINES.find((l) => l.line === line)?.title}方案`}
        className="grid gap-3 sm:grid-cols-2"
      >
        {LINE_PLANS[line].map(renderPlan)}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={expert} onChange={(e) => setExpert(e.target.checked)} />
        显示专家方案
      </label>
      {expert && (
        <div role="group" aria-label="专家与复测方案" className="grid gap-3 sm:grid-cols-2">
          {MORE_PLANS.map(renderPlan)}
        </div>
      )}
    </div>
  );
}
