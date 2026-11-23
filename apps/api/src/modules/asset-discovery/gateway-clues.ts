// AI 资产测绘第二线索：JJDGUARD 审计事件中出现过的上游模型。
// 网关未配置/未启用/令牌缺失/不可达时返回受限状态（不报错、不造数）。
import { prisma } from '../../db.js';
import { assertControlPlaneAllowed } from '../../lib/gateway-access.js';
import { fetchGatewayAuditEvents } from '../gateway-logs/client.js';
import { gatewayControlPlaneBaseUrl } from '../system-settings/routes.js';
import { loadRegisteredTargets } from './service.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GatewayClueDeps {
  fetchFn?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export const CLUE_WINDOW_DAYS = 7;
const CLUE_PAGE_SIZE = 500;
const CLUE_MAX_PAGES = 4;

export interface GatewayClue {
  model: string;
  providerId: string;
  endpointTypes: string[];
  eventCount: number;
  lastSeenAt: string | null;
  registered: boolean;
  targetId: string | null;
  targetName: string | null;
}

export type GatewayClueResult =
  | { status: 'NOT_CONNECTED'; message: string; clues: [] }
  | { status: 'UNREACHABLE'; message: string; clues: [] }
  | {
      status: 'OK';
      windowDays: number;
      eventCount: number;
      truncated: boolean;
      clues: GatewayClue[];
    };

const NOT_CONNECTED = '网关未接入，无法获取审计线索';

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export async function collectGatewayClues(deps: GatewayClueDeps = {}): Promise<GatewayClueResult> {
  const env = deps.env ?? process.env;
  const row = await prisma.systemSetting.findUnique({ where: { key: 'gateway' } });
  const gw = rec(row?.value);
  const base = typeof gw.gatewayBaseUrl === 'string' ? gw.gatewayBaseUrl.trim() : '';
  const token = env.NEWAPI_EVAL_INTEGRATION_TOKEN?.trim() ?? '';
  if (!base || gw.gatewayLinkageEnabled !== true || !token) {
    return { status: 'NOT_CONNECTED', message: NOT_CONNECTED, clues: [] };
  }
  let controlPlaneBaseUrl: string;
  try {
    controlPlaneBaseUrl = gatewayControlPlaneBaseUrl(base);
    assertControlPlaneAllowed(controlPlaneBaseUrl, env);
  } catch {
    return {
      status: 'NOT_CONNECTED',
      message: `${NOT_CONNECTED}（网关地址未获部署授权或格式不合法）`,
      clues: [],
    };
  }
  const now = deps.now?.() ?? new Date();
  let events;
  try {
    events = await fetchGatewayAuditEvents({
      controlPlaneBaseUrl,
      internalToken: token,
      tenantId: env.NEWAPI_TENANT_ID?.trim() || 'tenant_default',
      startTime: new Date(now.getTime() - CLUE_WINDOW_DAYS * 86_400_000).toISOString(),
      endTime: now.toISOString(),
      limit: CLUE_PAGE_SIZE,
      maxPages: CLUE_MAX_PAGES,
      fetchFn: deps.fetchFn,
    });
  } catch {
    return {
      status: 'UNREACHABLE',
      message: '网关不可达或审计接口返回异常，无法获取审计线索',
      clues: [],
    };
  }
  const agg = new Map<
    string,
    { model: string; providerId: string; types: Set<string>; count: number; last: string | null }
  >();
  for (const e of events) {
    const model = (e.target.model || e.target.model_id || '').trim();
    if (!model) continue;
    const providerId = (e.target.provider_id || '').trim();
    const key = `${providerId}\u0000${model}`;
    const cur = agg.get(key) ?? {
      model,
      providerId,
      types: new Set<string>(),
      count: 0,
      last: null,
    };
    cur.count += 1;
    if (e.target.endpoint_type) cur.types.add(e.target.endpoint_type);
    if (e.createdAt && (!cur.last || e.createdAt > cur.last)) cur.last = e.createdAt;
    agg.set(key, cur);
  }
  const targets = await loadRegisteredTargets();
  const clues = [...agg.values()]
    .map((c) => {
      // 审计事件不含上游地址，只能按模型名比对已登记对象。
      const t = targets.find((x) => x.model.trim() === c.model);
      return {
        model: c.model,
        providerId: c.providerId,
        endpointTypes: [...c.types].sort(),
        eventCount: c.count,
        lastSeenAt: c.last,
        registered: !!t,
        targetId: t?.id ?? null,
        targetName: t?.name ?? null,
      };
    })
    .sort((a, b) => b.eventCount - a.eventCount);
  return {
    status: 'OK',
    windowDays: CLUE_WINDOW_DAYS,
    eventCount: events.length,
    truncated: events.length >= CLUE_PAGE_SIZE * CLUE_MAX_PAGES,
    clues,
  };
}
