import { Prisma, type Organization } from '@prisma/client';
import {
  MAX_ORG_DEPTH,
  orgDepth,
  orgMoveProblem,
  orgSubtreeIds,
  type OrgTreeRow,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

export { MAX_ORG_DEPTH };
/** 组织路径的分隔：「总部 / 研发中心 / 安全组」。 */
export const ORG_PATH_SEPARATOR = ' / ';

type Tx = Prisma.TransactionClient;

/** 零宽字符（U+200B～U+200F、U+2060、U+FEFF）和控制字符。 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u2060\uFEFF\p{Cc}]/gu;

/**
 * 组织名称入库前的规范化：NFKC（全角字母数字、全角空格转半角）、去掉零宽字符和控制字符、去首尾空白。
 * 判重另外不分大小写（见 assertNameFree 和迁移里的唯一索引）。
 */
export function normalizeOrganizationName(raw: string): string {
  return raw.normalize('NFKC').replace(INVISIBLE_CHARS, '').trim();
}

const nameTaken = () => conflict('同一上级下已有同名组织', 'ORG_NAME_TAKEN');
const tooDeep = () => badRequest(`组织最多 ${MAX_ORG_DEPTH} 级`, 'ORG_TOO_DEEP');
const notEmpty = () => conflict('请先移走下级组织和成员', 'ORG_NOT_EMPTY');
const orgNotFound = () => notFound('组织不存在');
const parentNotFound = () => badRequest('上级组织不存在', 'ORG_PARENT_NOT_FOUND');

function prismaCode(err: unknown): string | undefined {
  return err instanceof Prisma.PrismaClientKnownRequestError ? err.code : undefined;
}

/**
 * 同一租户的组织树写操作串行执行：并发的移动可能把树改成环，并发的新建、移动可能超过层级上限。
 * 树很小（几十到几百个节点），每次在锁内整棵读出来校验。
 */
async function withTreeLock<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lse:organizations:${tenantId}`}::text))`;
    return fn(tx);
  });
}

async function loadTree(db: Tx, tenantId: string): Promise<Map<string, OrgTreeRow>> {
  const rows = await db.organization.findMany({
    where: { tenantId },
    select: { id: true, parentId: true },
  });
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * 同一上级下（parentId 为空即根节点）有没有同名的，不分大小写，与迁移里 lower("name") 的唯一索引一致。
 * 不用 Prisma 的 mode: 'insensitive'：它在 PostgreSQL 上是 ILIKE，名字里的 _ 和 % 会被当成通配符。
 */
async function assertNameFree(
  tx: Tx,
  tenantId: string,
  parentId: string | null,
  name: string,
  exceptId?: string,
) {
  const dup = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "organizations"
    WHERE "tenantId" = ${tenantId}
      AND "parentId" IS NOT DISTINCT FROM ${parentId}::text
      AND lower("name") = lower(${name}::text)
      AND "id" <> ${exceptId ?? ''}
    LIMIT 1`;
  if (dup.length > 0) throw nameTaken();
}

export interface CreateOrganizationInput {
  parentId?: string | null;
  name: string;
  sort?: number;
}

/** 新建组织：上级必须是本租户的组织，同一上级下不重名，不超过 MAX_ORG_DEPTH 级。 */
export async function createOrganization(
  tenantId: string,
  input: CreateOrganizationInput,
): Promise<Organization> {
  const name = normalizeOrganizationName(input.name);
  if (!name) throw badRequest('组织名称不能为空', 'ORG_NAME_REQUIRED');
  const parentId = input.parentId ?? null;
  try {
    return await withTreeLock(tenantId, async (tx) => {
      if (parentId) {
        const tree = await loadTree(tx, tenantId);
        if (!tree.has(parentId)) throw parentNotFound();
        if (orgDepth(tree, parentId) >= MAX_ORG_DEPTH) throw tooDeep();
      }
      await assertNameFree(tx, tenantId, parentId, name);
      return tx.organization.create({
        data: { tenantId, parentId, name, sort: input.sort ?? 0 },
      });
    });
  } catch (err) {
    if (prismaCode(err) === 'P2002') throw nameTaken();
    throw err;
  }
}

export interface UpdateOrganizationInput {
  name?: string;
  /** undefined = 不改上级；null = 移到根。 */
  parentId?: string | null;
  sort?: number;
}

/** 改名、排序、改上级。改上级时防成环、防超过层级上限。返回改前和改后。 */
export async function updateOrganization(
  tenantId: string,
  id: string,
  input: UpdateOrganizationInput,
): Promise<{ before: Organization; after: Organization }> {
  const nextName = input.name === undefined ? undefined : normalizeOrganizationName(input.name);
  if (nextName !== undefined && !nextName)
    throw badRequest('组织名称不能为空', 'ORG_NAME_REQUIRED');
  try {
    return await withTreeLock(tenantId, async (tx) => {
      const before = await tx.organization.findFirst({ where: { id, tenantId } });
      if (!before) throw orgNotFound();
      const parentId = input.parentId === undefined ? before.parentId : input.parentId;
      const name = nextName ?? before.name;
      if (parentId !== before.parentId && parentId) {
        const tree = await loadTree(tx, tenantId);
        if (!tree.has(parentId)) throw parentNotFound();
        const problem = orgMoveProblem(tree, id, parentId);
        if (problem === 'cycle') {
          throw badRequest('不能移到自己或自己的下级组织下', 'ORG_CYCLE');
        }
        if (problem === 'too_deep') throw tooDeep();
      }
      if (parentId !== before.parentId || name !== before.name) {
        await assertNameFree(tx, tenantId, parentId, name, id);
      }
      const after = await tx.organization.update({
        where: { id },
        data: { name, parentId, ...(input.sort !== undefined ? { sort: input.sort } : {}) },
      });
      return { before, after };
    });
  } catch (err) {
    if (prismaCode(err) === 'P2002') throw nameTaken();
    throw err;
  }
}

/** 删除组织：有下级或成员就 409，不级联。 */
export async function deleteOrganization(tenantId: string, id: string): Promise<Organization> {
  try {
    return await withTreeLock(tenantId, async (tx) => {
      const row = await tx.organization.findFirst({ where: { id, tenantId } });
      if (!row) throw orgNotFound();
      const children = await tx.organization.count({ where: { parentId: id } });
      const members = await tx.user.count({ where: { organizationId: id } });
      if (children > 0 || members > 0) throw notEmpty();
      await tx.organization.delete({ where: { id } });
      return row;
    });
  } catch (err) {
    // 校验之后有人刚把用户绑进来：外键 RESTRICT 拦下，同样按「不空」处理。
    if (prismaCode(err) === 'P2003') throw notEmpty();
    throw err;
  }
}

/** 某个组织及其全部下级的 id（按该组织所在租户的树算）。 */
export async function organizationSubtreeIds(org: Pick<Organization, 'id' | 'tenantId'>) {
  return orgSubtreeIds(await loadTree(prisma, org.tenantId), org.id);
}

/**
 * 组织 id → 路径（「总部 / 研发中心 / 安全组」）。先查出这些组织所属的租户，再把这些租户的组织
 * 一次读出来在内存里拼，不逐级查库。在当前租户范围内查询，全部租户视角下不过滤。
 */
export async function organizationPaths(
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const owners = await prisma.organization.findMany({
    where: { id: { in: wanted } },
    distinct: ['tenantId'],
    select: { tenantId: true },
  });
  if (owners.length === 0) return new Map();
  const rows = new Map(
    (
      await prisma.organization.findMany({
        where: { tenantId: { in: owners.map((row) => row.tenantId) } },
        select: { id: true, parentId: true, name: true },
      })
    ).map((row) => [row.id, row]),
  );
  const paths = new Map<string, string>();
  for (const id of wanted) {
    const names: string[] = [];
    let cur = rows.get(id);
    while (cur && names.length <= MAX_ORG_DEPTH) {
      names.unshift(cur.name);
      cur = cur.parentId ? rows.get(cur.parentId) : undefined;
    }
    if (names.length > 0) paths.set(id, names.join(ORG_PATH_SEPARATOR));
  }
  return paths;
}

export interface OrganizationNode {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
  memberCount: number;
  children: OrganizationNode[];
}

/** 平铺的行（已按 sort、createdAt 排好）拼成树；找不到上级的当根节点。 */
export function buildOrganizationTree(
  rows: Pick<Organization, 'id' | 'name' | 'parentId' | 'sort'>[],
  memberCounts: Map<string, number>,
): OrganizationNode[] {
  const nodes = new Map<string, OrganizationNode>(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        parentId: row.parentId,
        sort: row.sort,
        memberCount: memberCounts.get(row.id) ?? 0,
        children: [],
      },
    ]),
  );
  const roots: OrganizationNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** 各组织的直属成员数。 */
export async function organizationMemberCounts(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.user.groupBy({
    by: ['organizationId'],
    where: { organizationId: { in: ids } },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.organizationId ?? '', row._count._all]));
}
