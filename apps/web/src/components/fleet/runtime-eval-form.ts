import { api } from '@/lib/api';
import { errorMessage } from '@/lib/fleet';
import {
  RUNTIME_VECTORS,
  type RuntimeArm,
  type RuntimeTemplate,
  type RuntimeTier,
  type RuntimeVector,
} from '../../../../../packages/shared/src/runtime-eval';

/** 运行态测评目前只对 Claude Code 开放。 */
export const RUNTIME_PRODUCT = 'claude-code' as const;
export const RUNTIME_V2_UNSUPPORTED_HINT = '终端的测评执行器版本过旧，请升级探针';
export const RUNTIME_ONLY_CLAUDE_HINT = '运行态测评目前只支持 Claude Code，请先勾选 Claude Code';

export const RUNTIME_TIER_INFO: Record<
  RuntimeTier,
  { label: string; hint: string; scale: string }
> = {
  quick: {
    label: '快速',
    hint: '每类 1 个样本，1 次，仅防护关',
    scale: '快速档约 6 个场景，约 16 分钟（每多选一个防护臂，场景数翻倍）',
  },
  standard: {
    label: '标准',
    hint: '每类最多 5 个样本，每个重复 2 次，防护关/开各一组',
    scale: '标准档约 60 到 120 个场景，约 3 到 5.5 小时',
  },
  full: {
    label: '完整',
    hint: '全部样本，每个重复 3 次，防护关/开各一组，两个项目模板',
    scale:
      '完整档运行全部样本，预计耗时和场景数都很可能超过上限（6 小时、240 个场景），需要减少类别、重复次数、模板或防护臂',
  },
};
export const RUNTIME_ARM_INFO: Record<RuntimeArm, { label: string; hint: string }> = {
  observe: { label: '防护关', hint: '只观察不拦截，用来看智能体自己会不会做' },
  enforce: { label: '防护开', hint: '启用终端本地策略拦截，用来看防护能拦住什么' },
};
export const RUNTIME_TEMPLATE_LABELS: Record<RuntimeTemplate, string> = {
  'py-service-v1': 'Python 库存服务',
  'node-api-v1': 'Node 订单接口',
};

export interface RuntimeForm {
  tier: RuntimeTier;
  vectors: RuntimeVector[];
  arms: RuntimeArm[];
  templates: RuntimeTemplate[];
  repeat: number;
}

/** 缺省随档位：快速只开防护关、重复 1 次；完整选两个项目模板。 */
export function runtimeTierDefaults(tier: RuntimeTier) {
  const arms: RuntimeArm[] = tier === 'quick' ? ['observe'] : ['observe', 'enforce'];
  const templates: RuntimeTemplate[] =
    tier === 'full' ? ['py-service-v1', 'node-api-v1'] : ['py-service-v1'];
  return { arms, templates, repeat: tier === 'quick' ? 1 : tier === 'standard' ? 2 : 3 };
}
export const defaultRuntimeForm = (): RuntimeForm => ({
  tier: 'standard',
  vectors: [...RUNTIME_VECTORS],
  ...runtimeTierDefaults('standard'),
});
export const runtimeFormValid = (f: RuntimeForm) =>
  !!f.vectors.length &&
  !!f.arms.length &&
  !!f.templates.length &&
  Number.isInteger(f.repeat) &&
  f.repeat >= 1 &&
  f.repeat <= 5;

/** POST /fleet/endpoints/:id/eval-jobs 的运行态请求体；备注为空时不带 reason。 */
export function runtimeJobBody(form: RuntimeForm, reason: string) {
  return {
    product: RUNTIME_PRODUCT,
    suite: 'runtime_v2' as const,
    tier: form.tier,
    vectors: form.vectors,
    arms: form.arms,
    repeat: form.repeat,
    templates: form.templates,
    ...(reason ? { reason } : {}),
  };
}

/**
 * claude-code 是否上报了 runtimeV2（后端取自心跳 eval_sandbox_v2 能力）。
 * 终端清单（agents[].product）带该字段；概览行（agents[].key）带了同样认。
 */
export function runtimeV2Reported(
  endpointAgents: { product: string; runtimeV2?: boolean }[] | undefined,
  overviewAgents?: { key: string; runtimeV2?: boolean }[],
): boolean {
  return (
    !!endpointAgents?.some((a) => a.product === RUNTIME_PRODUCT && a.runtimeV2 === true) ||
    !!overviewAgents?.some((a) => a.key === RUNTIME_PRODUCT && a.runtimeV2 === true)
  );
}
/** 运行态测评不可选的原因；可选时返回空串。 */
export function runtimeBlockedReason(chosenProducts: string[], runtimeV2: boolean): string {
  if (!chosenProducts.includes(RUNTIME_PRODUCT)) return RUNTIME_ONLY_CLAUDE_HINT;
  return runtimeV2 ? '' : RUNTIME_V2_UNSUPPORTED_HINT;
}

export function formatEstimate(seconds: number): string {
  return seconds < 3600
    ? `${Math.max(1, Math.round(seconds / 60))} 分钟`
    : `${Math.round(seconds / 360) / 10} 小时`;
}
/** 提交成功后用响应里的实际场景数和估算耗时；响应没带就不写数字。 */
export function runtimeStartedText(r: { scenarioCount?: unknown; estimate_seconds?: unknown; batchCount?: unknown }) {
  const parts = [
    typeof r.batchCount === 'number' && r.batchCount > 1 ? `已拆成 ${r.batchCount} 个任务依次执行` : '',
    typeof r.scenarioCount === 'number' ? `共 ${r.scenarioCount} 个场景` : '',
    typeof r.estimate_seconds === 'number' ? `预计约 ${formatEstimate(r.estimate_seconds)}` : '',
  ].filter(Boolean);
  return `运行态测评已下发${parts.length ? `：${parts.join('，')}` : ''}，待终端领取。`;
}
/** 409 FLEET_SANDBOX_V2_UNSUPPORTED 给中文提示；其余 400/409 原样显示后端信息。 */
export function runtimeErrorMessage(err: unknown, fallback: string): string {
  return (err as { code?: unknown } | null)?.code === 'FLEET_SANDBOX_V2_UNSUPPORTED'
    ? `${RUNTIME_V2_UNSUPPORTED_HINT}后再发起运行态测评。`
    : errorMessage(err, fallback);
}
/** 发起一个运行态测评任务，返回任务 id 和带实际场景数的成功提示。 */
export async function startRuntimeJob(endpointId: string, form: RuntimeForm, reason: string) {
  const result = await api.fleet.requestEvalJob(endpointId, runtimeJobBody(form, reason));
  return { taskId: result.taskId ?? result.evalTaskId ?? null, text: runtimeStartedText(result) };
}
