import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type DictItem, type DictType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

// 2.9.4 数据字典：平台级。管理接口读要 system_setting:read，写要 system_setting:update；
// 业务取数接口 GET /:code/items 登录即可读。
// 内置字典（如风险等级）的取值与代码里的枚举对应：类型不能改名、不能删；条目只能改名称、排序和启停，
// 不能新增、改值或删除。

const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const codeParams = z.object({
  code: z.string().regex(CODE_PATTERN, '编码只能用小写字母、数字和下划线，以字母开头'),
});
const itemParams = codeParams.extend({ id: z.string().uuid() });
/** 描述留空（含全是空格）存成 null。 */
const descriptionField = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v));
const createTypeBody = z.object({
  code: codeParams.shape.code,
  name: z.string().trim().min(1).max(64),
  description: descriptionField,
});
const updateTypeBody = z.object({
  // 编码是业务取数的键，建好后不能改；传了不同的值报错，不静默忽略。
  code: z.string().optional(),
  name: createTypeBody.shape.name.optional(),
  description: descriptionField,
});
const createItemBody = z.object({
  value: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(64),
  sort: z.number().int().min(0).max(1_000_000).optional(),
  enabled: z.boolean().default(true),
});
const updateItemBody = z
  .object({
    value: createItemBody.shape.value,
    label: createItemBody.shape.label,
    sort: z.number().int().min(0).max(1_000_000),
    enabled: z.boolean(),
  })
  .partial();
const reorderBody = z.object({ ids: z.array(z.string().uuid()).max(1000) });

const ITEM_ORDER = [
  { sort: 'asc' },
  { createdAt: 'asc' },
] satisfies Prisma.DictItemOrderByWithRelationInput[];

function serializeType(type: DictType, itemCount?: number) {
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    description: type.description,
    builtin: type.builtin,
    ...(itemCount === undefined ? {} : { itemCount }),
    createdAt: type.createdAt.toISOString(),
    updatedAt: type.updatedAt.toISOString(),
  };
}

function serializeItem(item: DictItem) {
  return {
    id: item.id,
    typeId: item.typeId,
    value: item.value,
    label: item.label,
    sort: item.sort,
    enabled: item.enabled,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** PATCH 至少要改一项；空 body 不更新、不刷新 updatedAt、不记审计。 */
function requireChanges(changes: Record<string, unknown>): void {
  if (Object.values(changes).every((v) => v === undefined)) {
    throw badRequest('没有要修改的内容', 'NOTHING_TO_UPDATE');
  }
}

async function findType(code: string): Promise<DictType> {
  const type = await prisma.dictType.findUnique({ where: { code } });
  if (!type) throw notFound('字典类型不存在', 'DICT_TYPE_NOT_FOUND');
  return type;
}

async function findItem(type: DictType, id: string): Promise<DictItem> {
  const item = await prisma.dictItem.findFirst({ where: { id, typeId: type.id } });
  if (!item) throw notFound('字典条目不存在', 'DICT_ITEM_NOT_FOUND');
  return item;
}

function audit(
  request: FastifyRequest,
  action: string,
  targetType: 'dict_type' | 'dict_item',
  targetId: string,
  detail: Record<string, unknown>,
) {
  return writeAudit({
    actorId: request.currentUser!.id,
    actorName: request.currentUser!.username,
    action,
    targetType,
    targetId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    detail,
  });
}

export async function dictionaryRoutes(app: FastifyInstance): Promise<void> {
  const canRead = [authenticate, requirePermission('system_setting:read')];
  const canWrite = [authenticate, requirePermission('system_setting:update')];
  const loggedIn = [authenticate];

  app.get('/', { preHandler: canRead }, async () => {
    const types = await prisma.dictType.findMany({
      orderBy: [{ builtin: 'desc' }, { createdAt: 'asc' }],
      include: { _count: { select: { items: true } } },
    });
    return { items: types.map((t) => serializeType(t, t._count.items)) };
  });

  app.post('/', { preHandler: canWrite }, async (request, reply) => {
    const body = createTypeBody.parse(request.body ?? {});
    let type: DictType;
    try {
      type = await prisma.dictType.create({
        data: { code: body.code, name: body.name, description: body.description ?? null },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('字典编码已存在', 'DICT_TYPE_EXISTS');
      throw err;
    }
    await audit(request, 'dictionary.type_create', 'dict_type', type.id, {
      code: type.code,
      name: type.name,
    });
    reply.code(201);
    return serializeType(type, 0);
  });

  // 管理视图：类型 + 全部条目（含停用）。
  app.get('/:code', { preHandler: canRead }, async (request) => {
    const { code } = codeParams.parse(request.params);
    const type = await findType(code);
    const items = await prisma.dictItem.findMany({
      where: { typeId: type.id },
      orderBy: ITEM_ORDER,
    });
    return { ...serializeType(type, items.length), items: items.map(serializeItem) };
  });

  app.patch('/:code', { preHandler: canWrite }, async (request) => {
    const { code } = codeParams.parse(request.params);
    const { code: newCode, ...changes } = updateTypeBody.parse(request.body ?? {});
    const existing = await findType(code);
    if (newCode !== undefined && newCode !== existing.code) {
      throw badRequest('字典编码不能修改', 'DICT_TYPE_CODE_LOCKED');
    }
    requireChanges(changes);
    if (existing.builtin && changes.name !== undefined && changes.name !== existing.name) {
      throw badRequest('内置字典不能改名', 'DICT_TYPE_BUILTIN');
    }
    const type = await prisma.dictType.update({
      where: { id: existing.id },
      data: { name: changes.name, description: changes.description },
    });
    await audit(request, 'dictionary.type_update', 'dict_type', type.id, {
      code: type.code,
      changed: Object.keys(changes).filter(
        (key) => changes[key as keyof typeof changes] !== undefined,
      ),
    });
    return serializeType(type);
  });

  app.delete('/:code', { preHandler: canWrite }, async (request) => {
    const { code } = codeParams.parse(request.params);
    const type = await findType(code);
    if (type.builtin) throw badRequest('内置字典类型不能删除', 'DICT_TYPE_BUILTIN');
    const itemCount = await prisma.dictItem.count({ where: { typeId: type.id } });
    await prisma.dictType.delete({ where: { id: type.id } });
    await audit(request, 'dictionary.type_delete', 'dict_type', type.id, {
      code: type.code,
      name: type.name,
      itemCount,
    });
    return { ok: true };
  });

  // 供业务取用：登录即可读，只返回启用的条目，按 sort 排序。
  app.get('/:code/items', { preHandler: loggedIn }, async (request) => {
    const { code } = codeParams.parse(request.params);
    const type = await findType(code);
    const items = await prisma.dictItem.findMany({
      where: { typeId: type.id, enabled: true },
      orderBy: ITEM_ORDER,
    });
    return { items: items.map(serializeItem) };
  });

  app.post('/:code/items', { preHandler: canWrite }, async (request, reply) => {
    const { code } = codeParams.parse(request.params);
    const body = createItemBody.parse(request.body ?? {});
    const type = await findType(code);
    if (type.builtin) throw badRequest('内置字典不能新增条目', 'DICT_ITEM_BUILTIN');
    let sort = body.sort;
    if (sort === undefined) {
      const last = await prisma.dictItem.aggregate({
        where: { typeId: type.id },
        _max: { sort: true },
      });
      sort = (last._max.sort ?? 0) + 1;
    }
    let item: DictItem;
    try {
      item = await prisma.dictItem.create({
        data: {
          typeId: type.id,
          value: body.value,
          label: body.label,
          sort,
          enabled: body.enabled,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('该类型下已有相同的值', 'DICT_ITEM_EXISTS');
      throw err;
    }
    await audit(request, 'dictionary.item_create', 'dict_item', item.id, {
      code: type.code,
      value: item.value,
      label: item.label,
    });
    reply.code(201);
    return serializeItem(item);
  });

  // 按给定顺序重排：ids 必须正好是该类型的全部条目。注册在 /:code/items/:id 之前。
  app.put('/:code/items/order', { preHandler: canWrite }, async (request) => {
    const { code } = codeParams.parse(request.params);
    const { ids } = reorderBody.parse(request.body ?? {});
    const type = await findType(code);
    const existing = await prisma.dictItem.findMany({
      where: { typeId: type.id },
      select: { id: true },
    });
    const known = new Set(existing.map((i) => i.id));
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== known.size ||
      ids.some((id) => !known.has(id))
    ) {
      throw badRequest('排序列表与当前条目不一致，请刷新后重试', 'DICT_ORDER_MISMATCH');
    }
    await prisma.$transaction(
      ids.map((id, index) => prisma.dictItem.update({ where: { id }, data: { sort: index + 1 } })),
    );
    await audit(request, 'dictionary.item_reorder', 'dict_type', type.id, {
      code: type.code,
      count: ids.length,
    });
    const items = await prisma.dictItem.findMany({
      where: { typeId: type.id },
      orderBy: ITEM_ORDER,
    });
    return { items: items.map(serializeItem) };
  });

  app.patch('/:code/items/:id', { preHandler: canWrite }, async (request) => {
    const { code, id } = itemParams.parse(request.params);
    const body = updateItemBody.parse(request.body ?? {});
    const type = await findType(code);
    const existing = await findItem(type, id);
    requireChanges(body);
    if (type.builtin && body.value !== undefined && body.value !== existing.value) {
      throw badRequest('内置条目不能修改取值', 'DICT_ITEM_BUILTIN');
    }
    let item: DictItem;
    try {
      item = await prisma.dictItem.update({ where: { id }, data: body });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('该类型下已有相同的值', 'DICT_ITEM_EXISTS');
      throw err;
    }
    await audit(request, 'dictionary.item_update', 'dict_item', item.id, {
      code: type.code,
      value: item.value,
      changed: body,
    });
    return serializeItem(item);
  });

  app.delete('/:code/items/:id', { preHandler: canWrite }, async (request) => {
    const { code, id } = itemParams.parse(request.params);
    const type = await findType(code);
    const item = await findItem(type, id);
    if (type.builtin) throw badRequest('内置条目不能删除', 'DICT_ITEM_BUILTIN');
    await prisma.dictItem.delete({ where: { id } });
    await audit(request, 'dictionary.item_delete', 'dict_item', item.id, {
      code: type.code,
      value: item.value,
      label: item.label,
    });
    return { ok: true };
  });
}
