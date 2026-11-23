import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { tenantIsPlatform } from '../../lib/all-tenants.js';
import type { CurrentUser } from '../../lib/rbac.js';
import { AgentShieldClient } from '../endpoint-evals/agentshield-client.js';
import { endpointProductSchema } from '../endpoint-evals/config.js';
import { FLEET_TARGET_PROVIDER } from '../fleet-admin/service.js';

/**
 * 终端类评估对象绑定的终端还在不在：
 * active 在；gone 来源那边已经没有（自管：不存在、已吊销或已删除；平台：平台明确回答登记不存在）；
 * unknown 判断不了（连接器未配置、无权限、调用失败、对象保存的平台地址不是当前部署、超过单次确认上限）。
 *
 * 平台来源不能只看清单：清单接口会丢掉「暂时没有可测智能体」的登记，登记其实还在。
 * 清单里没有的，再用 posture 接口逐个确认——它对已删除、已吊销、停用、退役的登记返回 404 not_found，
 * 对还在的登记返回 200。
 */
export type EndpointState = 'active' | 'gone' | 'unknown';

type TargetLike = { id: string; targetType: string; provider: string; accessConfig: unknown };

/** 列表接口不能被连接器拖住：超过这个时间按调用失败处理。 */
const CONNECTOR_TIMEOUT_MS = 5_000;
/** 一次列表请求最多逐个确认这么多个登记，其余记为 unknown。 */
const CONFIRM_LIMIT = 5;

const connector = () => new AgentShieldClient({ egress: { timeoutMs: CONNECTOR_TIMEOUT_MS } });

const field = (config: unknown, key: string): string => {
  const value = config && typeof config === 'object' ? (config as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : '';
};

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * 进程内短缓存：连接器清单和逐个确认的结果各留 60 秒，失败结果（null / unknown）也留，
 * 平台不通时不会每次请求都去等。按部署的连接器地址分开存，换了地址不会用上旧结果。
 * 存的是进行中的调用本身，同时到达的请求共用一次调用。
 */
const CACHE_TTL_MS = 60_000;
type Cached<T> = { expiresAt: number; value: Promise<T> };
const listCache = new Map<string, Cached<Set<string> | null>>();
const existsCache = new Map<string, Cached<EndpointState>>();

/** 清空上面的缓存（测试用例之间重置）。 */
export function resetEndpointStateCache(): void {
  listCache.clear();
  existsCache.clear();
}

function cached<T>(cache: Map<string, Cached<T>>, key: string): Promise<T> | undefined {
  const now = Date.now();
  for (const [entryKey, entry] of cache) if (entry.expiresAt <= now) cache.delete(entryKey);
  return cache.get(key)?.value;
}

function remember<T>(cache: Map<string, Cached<T>>, key: string, value: Promise<T>): Promise<T> {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

/** 缓存键里的连接器地址：取 origin，地址写法不同（末尾斜杠等）算同一个。 */
function connectorOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl;
  }
}

/** 智能体安全平台当前的登记 ID；判断不了时返回 null。 */
function platformEndpointIds(user: CurrentUser, log: FastifyBaseLogger): Promise<Set<string> | null> {
  const serverUrl = process.env.LSE_AGENTSHIELD_BASE_URL;
  if (!serverUrl || !tenantIsPlatform(user)) return Promise.resolve(null);
  if (!user.permissions.has('model_target:create') && !user.permissions.has('eval_task:create')) return Promise.resolve(null);
  const key = connectorOrigin(serverUrl);
  return cached(listCache, key) ?? remember(listCache, key, (async () => {
    try {
      const remote: unknown = await connector().endpoints();
      if (!Array.isArray(remote)) throw new Error('连接器清单格式不正确');
      return new Set(remote.flatMap((endpoint) =>
        endpoint && typeof endpoint.endpoint_id === 'string' ? [endpoint.endpoint_id as string] : []));
    } catch (error) {
      log.warn({ err: error }, '读取智能体安全平台终端失败，终端类评估对象的终端状态记为未知');
      return null;
    }
  })());
}

/** 向平台确认一个登记还在不在：不存在 gone，还在 active，调用失败 unknown。 */
function confirmEndpoint(key: string, endpointId: string, product: string, log: FastifyBaseLogger): Promise<EndpointState> {
  return remember(existsCache, key, (async (): Promise<EndpointState> => {
    try {
      return (await connector().endpointExists(endpointId, product)) ? 'active' : 'gone';
    } catch (error) {
      log.warn({ err: error, endpointId }, '向智能体安全平台确认登记是否存在失败，终端状态记为未知');
      return 'unknown';
    }
  })());
}

/** 只给终端类对象算状态；其他类型不在返回的表里。 */
export async function resolveEndpointStates(
  targets: readonly TargetLike[],
  user: CurrentUser,
  log: FastifyBaseLogger,
): Promise<Map<string, EndpointState>> {
  const states = new Map<string, EndpointState>();
  const endpointTargets = targets.filter((target) => target.targetType === 'ENDPOINT_AGENT');
  if (!endpointTargets.length) return states;

  const fleetTargets = endpointTargets.filter((target) => target.provider === FLEET_TARGET_PROVIDER);
  if (fleetTargets.length) {
    const ids = fleetTargets.map((target) => field(target.accessConfig, 'fleetEndpointId')).filter(Boolean);
    const publicIds = fleetTargets.map((target) => field(target.accessConfig, 'endpointId')).filter(Boolean);
    const endpoints = await prisma.fleetEndpoint.findMany({
      where: { OR: [{ id: { in: ids } }, { publicId: { in: publicIds } }] },
      select: { id: true, publicId: true, status: true, removedAt: true },
    });
    for (const target of fleetTargets) {
      const id = field(target.accessConfig, 'fleetEndpointId');
      const publicId = field(target.accessConfig, 'endpointId');
      if (!id && !publicId) {
        states.set(target.id, 'unknown');
        continue;
      }
      const endpoint = endpoints.find((row) => (id ? row.id === id : row.publicId === publicId));
      states.set(target.id, endpoint && endpoint.status === 'ACTIVE' && !endpoint.removedAt ? 'active' : 'gone');
    }
  }

  const platformTargets = endpointTargets.filter((target) => target.provider !== FLEET_TARGET_PROVIDER);
  if (platformTargets.length) {
    const known = await platformEndpointIds(user, log);
    const serverUrl = process.env.LSE_AGENTSHIELD_BASE_URL ?? '';
    const unlisted: TargetLike[] = [];
    for (const target of platformTargets) {
      const endpointId = field(target.accessConfig, 'endpointId');
      if (!known || !endpointId || !sameOrigin(field(target.accessConfig, 'agentshieldBaseUrl'), serverUrl)) {
        states.set(target.id, 'unknown');
      } else if (known.has(endpointId)) states.set(target.id, 'active');
      else unlisted.push(target);
    }
    // 清单里没有不等于失效：逐个问平台登记还在不在。同一登记只问一次；
    // 缓存里有结果的直接用，不占名额；单次请求新发起的确认有上限，超出的记为 unknown。
    const origin = connectorOrigin(serverUrl);
    const answers = new Map<string, Promise<EndpointState>>();
    let started = 0;
    for (const target of unlisted) {
      const endpointId = field(target.accessConfig, 'endpointId');
      const product = field(target.accessConfig, 'product');
      if (answers.has(endpointId)) continue;
      const key = `${origin}\0${endpointId}`;
      const remembered = cached(existsCache, key);
      if (remembered) answers.set(endpointId, remembered);
      // posture 接口要求带一个平台认识的产品；登记是否存在与产品无关。
      else if (started < CONFIRM_LIMIT && endpointProductSchema.safeParse(product).success) {
        started += 1;
        answers.set(endpointId, confirmEndpoint(key, endpointId, product, log));
      }
    }
    for (const target of unlisted) {
      states.set(target.id, (await answers.get(field(target.accessConfig, 'endpointId'))) ?? 'unknown');
    }
  }
  return states;
}
