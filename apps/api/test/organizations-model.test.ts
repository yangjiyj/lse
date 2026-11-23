import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../src/db.js';
import { runInTenant } from '../src/lib/tenant-context.js';
import { AppError } from '../src/lib/errors.js';
import { orgDepth, orgMoveProblem, orgSubtreeHeight, orgSubtreeIds } from '@lse/shared';
import {
  MAX_ORG_DEPTH,
  createOrganization,
  organizationPaths,
  updateOrganization,
} from '../src/modules/organizations/service.js';

// 2.9.3 组织架构的数据模型：同一上级下不重名（含根节点、不分大小写）、名称规范化、最多 8 级、
// 按租户隔离；并发移动、新建不会成环或超深。

const TENANT_PREFIX = 'D1组织模型测试';
let tenantA = '';
let tenantB = '';

async function deleteTenantOrgs(tenantIds: string[]): Promise<void> {
  await prismaUnscoped.user.updateMany({
    where: { tenantId: { in: tenantIds } },
    data: { organizationId: null },
  });
  // 上级是 RESTRICT：从叶子往上删（并发用例万一出了超深的链，也要删得干净）。
  for (let i = 0; i <= 50; i += 1) {
    const r = await prismaUnscoped.organization.deleteMany({
      where: { tenantId: { in: tenantIds }, children: { none: {} } },
    });
    if (r.count === 0) break;
  }
}

async function cleanup(): Promise<void> {
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: { startsWith: TENANT_PREFIX } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await deleteTenantOrgs(ids);
  await prismaUnscoped.tenant.deleteMany({ where: { id: { in: ids } } });
}

const inA = <T>(fn: () => Promise<T>) => runInTenant(tenantA, fn);
const inB = <T>(fn: () => Promise<T>) => runInTenant(tenantB, fn);

function isStatus(status: number, code?: string) {
  return (err: unknown) => {
    assert.ok(err instanceof AppError, String(err));
    assert.equal(err.statusCode, status, err.message);
    if (code) assert.equal(err.code, code);
    return true;
  };
}

before(async () => {
  await cleanup();
  tenantA = (
    await prismaUnscoped.tenant.create({
      data: { name: `${TENANT_PREFIX}A`, code: 'd1-org-model-a' },
    })
  ).id;
  tenantB = (
    await prismaUnscoped.tenant.create({
      data: { name: `${TENANT_PREFIX}B`, code: 'd1-org-model-b' },
    })
  ).id;
});

after(async () => {
  await cleanup();
});

test('同一上级下重名返回 409，不同上级下可以同名', async () => {
  const root = await inA(() => createOrganization(tenantA, { name: '同名测试总部' }));
  const rd = await inA(() => createOrganization(tenantA, { parentId: root.id, name: '研发中心' }));
  const ops = await inA(() => createOrganization(tenantA, { parentId: root.id, name: '运营中心' }));
  await assert.rejects(
    inA(() => createOrganization(tenantA, { parentId: root.id, name: '研发中心' })),
    isStatus(409, 'ORG_NAME_TAKEN'),
  );
  // 名称前后空白不算不同的名字
  await assert.rejects(
    inA(() => createOrganization(tenantA, { parentId: root.id, name: ' 研发中心 ' })),
    isStatus(409, 'ORG_NAME_TAKEN'),
  );
  await inA(() => createOrganization(tenantA, { parentId: rd.id, name: '安全组' }));
  const other = await inA(() => createOrganization(tenantA, { parentId: ops.id, name: '安全组' }));
  assert.equal(other.parentId, ops.id);
  assert.equal(other.tenantId, tenantA);
});

test('根节点重名返回 409；不同租户的根节点可以同名', async () => {
  await inA(() => createOrganization(tenantA, { name: '根重名测试' }));
  await assert.rejects(
    inA(() => createOrganization(tenantA, { name: '根重名测试' })),
    isStatus(409, 'ORG_NAME_TAKEN'),
  );
  const inOther = await inB(() => createOrganization(tenantB, { name: '根重名测试' }));
  assert.equal(inOther.tenantId, tenantB);
  assert.equal(inOther.parentId, null);
});

test('根节点不重名由数据库兜底：绕过接口直接写库也会撞唯一约束', async () => {
  await prismaUnscoped.organization.create({ data: { tenantId: tenantA, name: '库级根重名' } });
  await assert.rejects(
    prismaUnscoped.organization.create({ data: { tenantId: tenantA, name: '库级根重名' } }),
    (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002',
  );
  // 同一租户、同名但不是根节点：不受根节点索引限制
  const parent = await prismaUnscoped.organization.create({
    data: { tenantId: tenantA, name: '库级上级' },
  });
  await prismaUnscoped.organization.create({
    data: { tenantId: tenantA, parentId: parent.id, name: '库级根重名' },
  });
});

test('8 级以内能建，第 9 级返回 400', async () => {
  assert.equal(MAX_ORG_DEPTH, 8);
  let parentId: string | null = null;
  for (let level = 1; level <= MAX_ORG_DEPTH; level += 1) {
    const pid: string | null = parentId;
    const node = await inA(() =>
      createOrganization(tenantA, { parentId: pid, name: `层级${level}` }),
    );
    parentId = node.id;
  }
  const deepest = parentId;
  await assert.rejects(
    inA(() => createOrganization(tenantA, { parentId: deepest, name: '层级9' })),
    isStatus(400, 'ORG_TOO_DEEP'),
  );
});

test('上级是别的租户的组织：400，且数据库拒绝跨租户挂接', async () => {
  const foreign = await inB(() => createOrganization(tenantB, { name: '别人的总部' }));
  await assert.rejects(
    inA(() => createOrganization(tenantA, { parentId: foreign.id, name: '挂到别人下面' })),
    isStatus(400, 'ORG_PARENT_NOT_FOUND'),
  );
  await assert.rejects(
    prismaUnscoped.organization.create({
      data: { tenantId: tenantA, parentId: foreign.id, name: '绕过接口挂接' },
    }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );
});

test('名称判重不分大小写：Dev 与 dev 同级 409，根节点也一样', async () => {
  const root = await inA(() => createOrganization(tenantA, { name: '大小写总部' }));
  await inA(() => createOrganization(tenantA, { parentId: root.id, name: 'Dev' }));
  await assert.rejects(
    inA(() => createOrganization(tenantA, { parentId: root.id, name: 'dev' })),
    isStatus(409, 'ORG_NAME_TAKEN'),
  );
  await inA(() => createOrganization(tenantA, { name: 'Root Case' }));
  await assert.rejects(
    inA(() => createOrganization(tenantA, { name: 'ROOT CASE' })),
    isStatus(409, 'ORG_NAME_TAKEN'),
  );
});

test('判重不把 _ 和 % 当通配符', async () => {
  const root = await inA(() => createOrganization(tenantA, { name: '通配符总部' }));
  await inA(() => createOrganization(tenantA, { parentId: root.id, name: 'A_B' }));
  await inA(() => createOrganization(tenantA, { parentId: root.id, name: 'AxB' }));
  await inA(() => createOrganization(tenantA, { parentId: root.id, name: '100%' }));
  await inA(() => createOrganization(tenantA, { parentId: root.id, name: '1000' }));
});

test('名称入库前规范化：去零宽字符和控制字符、NFKC、去首尾空白（含全角空格）', async () => {
  const root = await inA(() => createOrganization(tenantA, { name: '规范化总部' }));
  await inA(() => createOrganization(tenantA, { parentId: root.id, name: 'Dev' }));
  // 末尾带零宽空格的同名
  await assert.rejects(
    inA(() => createOrganization(tenantA, { parentId: root.id, name: 'Dev​' })),
    isStatus(409, 'ORG_NAME_TAKEN'),
  );
  // 全角字母 NFKC 后与 Dev 同名
  await assert.rejects(
    inA(() => createOrganization(tenantA, { parentId: root.id, name: 'Ｄｅｖ' })),
    isStatus(409, 'ORG_NAME_TAKEN'),
  );
  const fw = await inA(() =>
    createOrganization(tenantA, { parentId: root.id, name: '　安全组　' }),
  );
  assert.equal(fw.name, '安全组');
  const hidden = await inA(() =>
    createOrganization(tenantA, {
      parentId: root.id,
      name: '﻿运‍营⁠中‎心\u0007\t',
    }),
  );
  assert.equal(hidden.name, '运营中心');
  // 只剩不可见字符：当空名称处理
  await assert.rejects(
    inA(() => createOrganization(tenantA, { parentId: root.id, name: '​　‏' })),
    isStatus(400, 'ORG_NAME_REQUIRED'),
  );
  // 改名同样规范化
  const { after: renamed } = await inA(() =>
    updateOrganization(tenantA, hidden.id, { name: '　运营部​' }),
  );
  assert.equal(renamed.name, '运营部');
});

test('改名撞同级（大小写、空白不同）409；移到顶级撞根节点同名 409', async () => {
  const root = await inA(() => createOrganization(tenantA, { name: '改名总部' }));
  await inA(() => createOrganization(tenantA, { parentId: root.id, name: 'Dev' }));
  const ops = await inA(() => createOrganization(tenantA, { parentId: root.id, name: 'Ops' }));
  await assert.rejects(
    inA(() => updateOrganization(tenantA, ops.id, { name: ' dev ' })),
    isStatus(409, 'ORG_NAME_TAKEN'),
  );
  // 只改自己名字的大小写可以
  const { after } = await inA(() => updateOrganization(tenantA, ops.id, { name: 'OPS' }));
  assert.equal(after.name, 'OPS');
  const child = await inA(() =>
    createOrganization(tenantA, { parentId: root.id, name: '改名总部' }),
  );
  await assert.rejects(
    inA(() => updateOrganization(tenantA, child.id, { parentId: null })),
    isStatus(409, 'ORG_NAME_TAKEN'),
  );
});

test('大小写不同的同名由数据库兜底：同级、根节点都撞唯一约束', async () => {
  const isUnique = (err: unknown) =>
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  await prismaUnscoped.organization.create({ data: { tenantId: tenantA, name: '库级大小写Root' } });
  await assert.rejects(
    prismaUnscoped.organization.create({ data: { tenantId: tenantA, name: '库级大小写root' } }),
    isUnique,
  );
  const parent = await prismaUnscoped.organization.create({
    data: { tenantId: tenantA, name: '库级大小写上级' },
  });
  await prismaUnscoped.organization.create({
    data: { tenantId: tenantA, parentId: parent.id, name: 'Team' },
  });
  await assert.rejects(
    prismaUnscoped.organization.create({
      data: { tenantId: tenantA, parentId: parent.id, name: 'TEAM' },
    }),
    isUnique,
  );
});

test('并发互相移动 15 轮：不成环，也不会两边都成功', async () => {
  for (let round = 0; round < 15; round += 1) {
    const root = await inA(() => createOrganization(tenantA, { name: `并发移动根${round}` }));
    const x = await inA(() => createOrganization(tenantA, { parentId: root.id, name: 'X' }));
    const y = await inA(() => createOrganization(tenantA, { parentId: root.id, name: 'Y' }));
    const results = await Promise.allSettled([
      inA(() => updateOrganization(tenantA, x.id, { parentId: y.id })),
      inA(() => updateOrganization(tenantA, y.id, { parentId: x.id })),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 1, `第 ${round} 轮成功 ${ok} 个`);
    for (const r of results) {
      if (r.status === 'rejected') isStatus(400, 'ORG_CYCLE')(r.reason);
    }
    const rows = await prismaUnscoped.organization.findMany({
      where: { id: { in: [x.id, y.id] } },
    });
    const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
    assert.ok(!(parentOf.get(x.id) === y.id && parentOf.get(y.id) === x.id), `第 ${round} 轮成环`);
  }
});

test('并发「把子树移进深处」与「在子树底下新建」10 轮：不出现超过 8 级的节点', async () => {
  const chain = async (prefix: string, levels: number) => {
    const ids: string[] = [];
    for (let level = 1; level <= levels; level += 1) {
      const parentId = ids.at(-1) ?? null;
      const node = await inA(() =>
        createOrganization(tenantA, { parentId, name: `${prefix}-${level}` }),
      );
      ids.push(node.id);
    }
    return ids;
  };
  for (let round = 0; round < 10; round += 1) {
    // P 链 4 级；Q 链 4 级。Q 移到 P4 下正好 8 级，再在 Q4 下新建就是第 9 级：两者只能成一个。
    const p = await chain(`深处P${round}`, 4);
    const q = await chain(`深处Q${round}`, 4);
    const results = await Promise.allSettled([
      inA(() => updateOrganization(tenantA, q[0]!, { parentId: p[3]! })),
      inA(() => createOrganization(tenantA, { parentId: q[3]!, name: `深处Q${round}-5` })),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') isStatus(400, 'ORG_TOO_DEEP')(r.reason);
    }
    assert.equal(
      results.filter((r) => r.status === 'fulfilled').length,
      1,
      `第 ${round} 轮两边都成功或都失败`,
    );
    const rows = await prismaUnscoped.organization.findMany({
      where: { tenantId: tenantA },
      select: { id: true, parentId: true },
    });
    const tree = new Map(rows.map((row) => [row.id, row]));
    for (const row of rows) {
      assert.ok(orgDepth(tree, row.id) <= MAX_ORG_DEPTH, `第 ${round} 轮出现超过 8 级的节点`);
    }
  }
});

test('组织路径：一次给出多个租户、多级的路径，查不到的不返回', async () => {
  let parentId: string | null = null;
  const names: string[] = [];
  for (let level = 1; level <= MAX_ORG_DEPTH; level += 1) {
    const pid: string | null = parentId;
    const node = await inA(() =>
      createOrganization(tenantA, { parentId: pid, name: `路径${level}` }),
    );
    names.push(node.name);
    parentId = node.id;
  }
  const deepest = parentId!;
  const other = await inB(() => createOrganization(tenantB, { name: '乙路径根' }));
  const otherChild = await inB(() =>
    createOrganization(tenantB, { parentId: other.id, name: '乙路径下级' }),
  );
  const paths = await organizationPaths([
    deepest,
    otherChild.id,
    null,
    '00000000-0000-0000-0000-000000000000',
  ]);
  assert.equal(paths.get(deepest), names.join(' / '));
  assert.equal(paths.get(otherChild.id), '乙路径根 / 乙路径下级');
  assert.equal(paths.size, 2);
  // 租户范围内只看得到本租户的
  const scoped = await inA(() => organizationPaths([deepest, otherChild.id]));
  assert.deepEqual([...scoped.keys()], [deepest]);
});

test('移动校验（前后端共用）：移到自己或下级下是成环，目标层级 + 子树高度超过 8 级是超深', () => {
  // r1 ─ a ─ a1 ─ a2；r1 ─ b；c1 ─ c2 ─ … ─ c7
  const rows: { id: string; parentId: string | null }[] = [
    { id: 'r1', parentId: null },
    { id: 'a', parentId: 'r1' },
    { id: 'a1', parentId: 'a' },
    { id: 'a2', parentId: 'a1' },
    { id: 'b', parentId: 'r1' },
  ];
  for (let level = 1; level <= 7; level += 1) {
    rows.push({ id: `c${level}`, parentId: level === 1 ? null : `c${level - 1}` });
  }
  const tree = new Map(rows.map((row) => [row.id, row]));
  assert.equal(orgDepth(tree, 'a2'), 4);
  assert.equal(orgDepth(tree, 'c7'), 7);
  assert.equal(orgSubtreeHeight(tree, 'a'), 3);
  assert.equal(orgSubtreeHeight(tree, 'b'), 1);
  assert.deepEqual(orgSubtreeIds(tree, 'a'), ['a', 'a1', 'a2']);
  const cases: [string, string | null, 'cycle' | 'too_deep' | null][] = [
    ['a', 'a', 'cycle'],
    ['a', 'a2', 'cycle'],
    ['a', 'b', null],
    ['a', null, null],
    ['a', 'c5', null],
    ['a', 'c6', 'too_deep'],
    ['b', 'c7', null],
    ['a1', 'c7', 'too_deep'],
    ['c1', 'r1', null],
    ['c1', 'a', 'too_deep'],
  ];
  for (const [id, target, expected] of cases) {
    assert.equal(orgMoveProblem(tree, id, target), expected, `${id} → ${target ?? '顶级'}`);
  }
});
