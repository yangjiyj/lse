import { PrismaClient } from '@prisma/client';
import { config } from './config.js';
import { currentTenantScope, type TenantScope } from './lib/tenant-context.js';
import { TENANT_OWNED_MODELS, TENANT_SHARED_MODELS } from './lib/tenant-models.js';

const base = new PrismaClient({
  log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

type Args = Record<string, unknown>;

const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);
const WHERE_WRITE_OPS = new Set(['update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany']);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);
const DATA_UPDATE_OPS = new Set(['update', 'updateMany', 'updateManyAndReturn']);

/** 在原 where 上追加一个 AND 条件；保留顶层字段，findUnique/update 的唯一键仍然有效。 */
function addCondition(where: unknown, condition: Args): Args {
  const w: Args = where && typeof where === 'object' ? { ...(where as Args) } : {};
  const existing = w.AND === undefined ? [] : Array.isArray(w.AND) ? w.AND : [w.AND];
  return { ...w, AND: [...existing, condition] };
}

function stamp(data: unknown, scope: TenantScope, shared: boolean): unknown {
  if (Array.isArray(data)) return data.map((item) => stamp(item, scope, shared));
  if (!data || typeof data !== 'object') return data;
  const row = data as Args;
  // 平台管理员在平台租户里显式写平台共享数据（tenantId: null），如平台裁判模型。
  if (shared && scope.sharedWrite && 'tenantId' in row && row.tenantId === null) return row;
  return { ...row, tenantId: scope.tenantId };
}

/** 更新时不允许改归属租户。 */
function stripTenant(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (!('tenantId' in (data as Args))) return data;
  const { tenantId: _ignored, ...rest } = data as Args;
  return rest;
}

/**
 * 按当前租户改写查询参数（导出供单测）。
 * owned：读写都限定当前租户；shared：读 = 当前租户 + 平台共享（tenantId 为空），写 = 仅当前租户
 * （平台管理员在平台租户里还可以写平台共享）。新建的行一律打上当前租户。
 */
export function scopeArgs(model: string, operation: string, args: unknown, scope: TenantScope): unknown {
  const owned = TENANT_OWNED_MODELS.has(model);
  const shared = TENANT_SHARED_MODELS.has(model);
  if (!owned && !shared) return args;
  const tenantId = scope.tenantId;
  const own: Args = { tenantId };
  const ownOrShared: Args = { OR: [{ tenantId }, { tenantId: null }] };
  const readCondition = shared ? ownOrShared : own;
  const writeCondition = shared && scope.sharedWrite ? ownOrShared : own;
  const a: Args = args && typeof args === 'object' ? { ...(args as Args) } : {};

  if (READ_OPS.has(operation)) {
    a.where = addCondition(a.where, readCondition);
    return a;
  }
  if (WHERE_WRITE_OPS.has(operation)) {
    a.where = addCondition(a.where, writeCondition);
    if (DATA_UPDATE_OPS.has(operation)) a.data = stripTenant(a.data);
    return a;
  }
  if (CREATE_OPS.has(operation)) {
    a.data = stamp(a.data, scope, shared);
    return a;
  }
  if (operation === 'upsert') {
    a.where = addCondition(a.where, writeCondition);
    a.create = stamp(a.create, scope, shared);
    a.update = stripTenant(a.update);
    return a;
  }
  // 未知操作：宁可报错也不放过（新版 Prisma 增加操作时需要在这里补上）。
  throw new Error(`[tenant] 未处理的 Prisma 操作 ${model}.${operation}`);
}

const scoped = base.$extends({
  name: 'lse-tenant-scope',
  query: {
    $allModels: {
      // 同步返回 query(...)：保持 PrismaPromise，批量 $transaction([...]) 才能继续使用。
      $allOperations({ model, operation, args, query }) {
        const scope = currentTenantScope();
        if (!scope || !model) return query(args);
        return query(scopeArgs(model, operation, args, scope) as typeof args);
      },
    },
  },
});

/**
 * 全平台统一的数据库客户端：在登录用户的请求里自动按租户隔离（见 lib/tenant-context.ts）。
 * 类型沿用 PrismaClient，现有调用处不用改。
 */
export const prisma = scoped as unknown as PrismaClient;

/**
 * 不带租户隔离的原始客户端：只给租户管理、登录这类本来就跨租户的地方用。
 * 业务代码一律用上面的 prisma。
 */
export const prismaUnscoped = base;
