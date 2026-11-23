import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 当前请求的租户范围（多租户隔离的唯一来源）。
 *
 * - 登录用户的请求：authenticate 解析出「本次操作的租户」后写入，db.ts 的查询扩展据此自动过滤/填充 tenantId；
 * - 没有租户范围（后台 worker、终端接入协议、种子数据、直接调用模块函数的测试）：查询不过滤，
 *   新写入的行由数据库触发器从父对象继承租户（见迁移 20261106120000_multi_tenant）；
 * - asSystem()：请求里少数需要跨租户读平台配置的地方（如平台设置里引用的攻击模型）显式跳出租户范围。
 */
export interface TenantScope {
  /** 本次操作的租户；null 表示不按租户过滤。 */
  tenantId: string | null;
  /** 平台管理员在平台租户里操作：可以改平台共享（tenantId 为空）的数据，如内置样本、平台裁判模型。 */
  sharedWrite: boolean;
  /** 平台管理员的「全部租户」视角：查询扩展不过滤，写操作由 authenticate 兜底拒绝。 */
  allTenants?: boolean;
}

const storage = new AsyncLocalStorage<TenantScope>();

/** Fastify 回调式钩子里用：在 done 的整个后续生命周期里建立租户范围。 */
export function runInScope<T>(scope: TenantScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** 当前租户范围；null 表示不过滤（系统范围或全部租户视角）。 */
export function currentTenantScope(): TenantScope | null {
  const scope = storage.getStore();
  if (!scope || !scope.tenantId || scope.allTenants) return null;
  return scope;
}

/** 当前是否处于「全部租户」视角（查询扩展不过滤）。 */
export function isAllTenantsScope(): boolean {
  return Boolean(storage.getStore()?.allTenants);
}

export function currentTenantId(): string | null {
  return currentTenantScope()?.tenantId ?? null;
}

/** 更新当前请求的租户范围（authenticate 解析完用户后调用）。返回是否处在请求范围内。 */
export function setCurrentTenantScope(
  tenantId: string | null,
  sharedWrite: boolean,
  allTenants = false,
): boolean {
  const scope = storage.getStore();
  if (!scope) return false;
  scope.tenantId = allTenants ? null : tenantId;
  scope.sharedWrite = sharedWrite;
  scope.allTenants = allTenants;
  return true;
}

/** 在指定租户范围内执行（后台任务按任务所属租户运行时用）。 */
export function runInTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId, sharedWrite: false }, fn);
}

/**
 * 有租户时在租户范围内执行，没有（或未知）时直接执行。
 * worker 里按任务租户读取「本租户 + 平台共享」的数据（裁判模型等）时用。
 */
export function withTenant<T>(tenantId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!tenantId) return fn();
  return storage.run({ tenantId, sharedWrite: false }, fn);
}

/**
 * 跳出租户范围执行：只用于读取平台级配置引用的对象，调用处必须写明理由。
 * fn 必须是在内部 await 查询的 async 函数——Prisma 查询是惰性的，到 await 时才读取租户上下文，
 * 直接返回未 await 的查询会在外层（租户范围）执行。
 */
export function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ tenantId: null, sharedWrite: false }, fn);
}
