import { fleetAgentIdentity } from '../../../../packages/shared/src/fleet-agent-display.js';
import {
  FLEET_LIVE_PRODUCTS,
  LIVE_EVAL_BLOCKED_REASONS,
  type FleetLiveProduct,
} from '../../../../packages/shared/src/fleet-live-eval';
import type { BadgeTone } from '@/lib/format';
import type { FleetCodeStatus, FleetEndpoint, FleetJobStatus } from '@/lib/api';

export const FLEET_PATH = '/fleet';
/** 自管终端自动生成的评估对象的 provider（与后端 fleet-admin/service.ts 一致）。 */
export const FLEET_TARGET_PROVIDER = 'jiandun-fleet';

/** 自管终端生成的评估对象：返回关联的终端内部 id；其他对象返回 null。 */
export function fleetEndpointIdOf(target: {
  provider?: string | null;
  accessConfig?: Record<string, unknown> | null;
}): string | null {
  if (target.provider !== FLEET_TARGET_PROVIDER) return null;
  const id = target.accessConfig?.fleetEndpointId;
  return typeof id === 'string' && id ? id : null;
}
/** 终端页的「接入终端」页签：创建接入码，Linux 复制命令 / Windows 下载安装包。 */
export const FLEET_ENROLL_PATH = `${FLEET_PATH}?tab=enroll`;

export const FLEET_JOB_STATUS_LABELS: Record<FleetJobStatus, string> = {
  // 新任务不再经过审批；这个状态只会出现在升级前遗留的旧任务上，所以标明「历史」。
  PENDING_APPROVAL: '待审批（历史）',
  QUEUED: '待终端领取',
  DELIVERED: '已下发',
  RUNNING: '执行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  REJECTED: '已驳回',
  EXPIRED: '已过期',
  CANCELLED: '已取消',
};

export const FLEET_JOB_STATUS_TONE: Record<FleetJobStatus, BadgeTone> = {
  PENDING_APPROVAL: 'warning',
  QUEUED: 'info',
  DELIVERED: 'info',
  RUNNING: 'info',
  COMPLETED: 'success',
  FAILED: 'danger',
  REJECTED: 'neutral',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
};

export const FLEET_JOB_STATUS_HINT: Partial<Record<FleetJobStatus, string>> = {
  PENDING_APPROVAL: '等待管理员批准',
  QUEUED: '待终端领取',
  DELIVERED: '终端已领取，即将开始',
  RUNNING: '终端正在隔离工作区里运行',
};

export const FLEET_JOB_STATUSES = Object.keys(FLEET_JOB_STATUS_LABELS) as FleetJobStatus[];

export const FLEET_CODE_STATUS_LABELS: Record<FleetCodeStatus, string> = {
  ACTIVE: '可用',
  REVOKED: '已撤销',
  EXPIRED: '已过期',
  EXHAUSTED: '已用完',
};

export const FLEET_CODE_STATUS_TONE: Record<FleetCodeStatus, BadgeTone> = {
  ACTIVE: 'success',
  REVOKED: 'neutral',
  EXPIRED: 'neutral',
  EXHAUSTED: 'neutral',
};

/** 仍占用终端的任务状态（与后端 OPEN_JOB_STATUSES 一致）。 */
export const FLEET_OPEN_JOB_STATUSES: FleetJobStatus[] = [
  'PENDING_APPROVAL',
  'QUEUED',
  'DELIVERED',
  'RUNNING',
];

/** 真机测评能力以终端上报的测评执行器（evalRunner）为准，不再按操作系统一刀切。 */
export const LIVE_EVAL_UNAVAILABLE_HINT =
  '终端未上报真机测评能力：需要本机装有受支持的智能体，并在安装探针时开启测评';
/** 没有测评执行器时的出路：Linux 的一键命令已带开启参数，Windows 安装包会自动开启。 */
export const LIVE_EVAL_HOW_TO_ENABLE =
  '在终端上重新运行安装包或一键命令即可开启运行态测评（Linux 一键命令已自带开启参数，Windows 安装包会自动开启）。';
export const LIVE_EVAL_AVAILABLE_HINT = '在该终端上运行真实智能体做测评';

/** 发起真机测评时可选的产品：必须由终端明确上报支持且已登记，没有上报时不允许发起。 */
export function selectableProducts(endpoint: Pick<FleetEndpoint, 'agents'>): {
  products: FleetLiveProduct[];
  reported: boolean;
} {
  const products = endpoint.agents
    .filter((a) => a.liveEvalRegistered === true && a.liveEvalSupported === true)
    .map((a) => a.product)
    .filter((p): p is FleetLiveProduct => FLEET_LIVE_PRODUCTS.includes(p as FleetLiveProduct));
  return { products: [...new Set(products)], reported: endpoint.agents.length > 0 };
}

const LEGACY_FLEET_NAME_RE = /^自管终端 (.+)（ep_[0-9a-f]{8,}）$/;

/**
 * 自管终端对象的展示名。升级前自动生成的名称带终端内部编号（「自管终端 主机名（ep_…）」），
 * 新名称在下次发起体检/测评时才会写回数据库，这之前先在界面上去掉编号；用户手改过的名称原样显示。
 */
export function targetDisplayName(target: {
  name: string;
  provider?: string | null;
  accessConfig?: Record<string, unknown> | null;
}): string {
  if (target.provider !== FLEET_TARGET_PROVIDER) return target.name;
  const host = LEGACY_FLEET_NAME_RE.exec(target.name)?.[1];
  return host ?? target.name;
}

/** 探针版本可能是 40 位提交号：列表里只显示前 8 位，完整内容放在悬停提示里。 */
export function shortProbeVersion(version: string | null | undefined): string {
  const v = (version ?? '').trim();
  if (!v) return '—';
  return /^[0-9a-f]{12,}$/i.test(v) ? v.slice(0, 8) : v;
}

/** 终端体检里的「已装智能体」：同名同版本去重，version_unknown 显示为「版本未知」。 */
export function formatInstalledAgents(
  agents: Array<{ name: string; version: string | null }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of agents) {
    const name = fleetAgentIdentity(a.name);
    const version = a.version && a.version !== 'version_unknown' ? a.version : null;
    const text = `${name} ${version ?? '版本未知'}`;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** 复制文本：优先用剪贴板接口，非安全上下文（http）下退回到临时文本框。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 退回到旧方式 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** bash 单引号转义，用于拼复制即用的命令。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface OneclickCommandOptions {
  scriptUrl: string;
  scriptSha256: string;
  scriptFile: string;
  code: string;
}

/**
 * Linux 一键接入命令：下载脚本 → 校验脚本 sha256 → sudo 执行。
 * 固定带 --enable-eval：本机没有 claude / codex 时脚本只提示、不报错。
 * 不带 --switch：本机已接入别的服务端时，脚本会在终端里提示加 --switch 重跑。
 */
export function buildOneclickCommand(o: OneclickCommandOptions): string {
  return (
    `curl -fsSL ${shellQuote(o.scriptUrl)} -o ${o.scriptFile}` +
    ` && echo ${shellQuote(`${o.scriptSha256}  ${o.scriptFile}`)} | sha256sum -c -` +
    ` && sudo bash ${o.scriptFile} --code ${shellQuote(o.code)} --enable-eval`
  );
}

/** 展示原因码时同时给出管理员可执行的下一步，未知原因也不能当作检查通过。 */
export function liveEvalErrorReason(code: string | null | undefined): string {
  if (!code) return '';
  return LIVE_EVAL_BLOCKED_REASONS[code] ?? '终端未完成检查，请查看各场景的执行原因。';
}
