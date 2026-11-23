import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  LEDGER_RELATION_RULES,
  PLATFORM_ONLY_PERMISSIONS,
  ROLE_DEFS,
  ledgerRelationAllowed,
} from '@lse/shared';
import { prismaUnscoped as db } from '../src/db.js';
import { TENANT_OWNED_MODELS } from '../src/lib/tenant-models.js';

// 2.8.1 应用台账的数据模型：租户补齐与跨租户守卫、唯一约束、关系级联、关系规则、权限点。

const TENANT_PREFIX = 'C1台账模型测试';
const USER_PREFIX = '__c1_ledger_';
let tenantA = '';
let tenantB = '';
let userA = '';

async function cleanup(): Promise<void> {
  const tenants = await db.tenant.findMany({
    where: { name: { startsWith: TENANT_PREFIX } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await db.ledgerAsset.deleteMany({ where: { tenantId: { in: ids } } });
  await db.fleetEndpoint.deleteMany({ where: { tenantId: { in: ids } } });
  await db.organization.deleteMany({ where: { tenantId: { in: ids } } });
  await db.user.deleteMany({ where: { username: { startsWith: USER_PREFIX } } });
  await db.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function endpoint(tenantId: string, hostname: string) {
  return db.fleetEndpoint.create({
    data: {
      tenantId,
      publicId: `ep_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      installationId: randomUUID(),
      machineId: 'm'.repeat(32),
      hostname,
      os: 'linux',
      tokenHash: randomUUID(),
    },
  });
}

const isUnique = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

before(async () => {
  await cleanup();
  tenantA = (await db.tenant.create({ data: { name: `${TENANT_PREFIX}A`, code: 'c1-ledger-a' } }))
    .id;
  tenantB = (await db.tenant.create({ data: { name: `${TENANT_PREFIX}B`, code: 'c1-ledger-b' } }))
    .id;
  userA = (
    await db.user.create({
      data: {
        tenantId: tenantA,
        username: `${USER_PREFIX}a`,
        passwordHash: 'x',
        displayName: '台账甲',
      },
    })
  ).id;
});

after(async () => {
  await cleanup();
});

test('台账两张表登记为租户内数据', () => {
  assert.ok(TENANT_OWNED_MODELS.has('LedgerAsset'));
  assert.ok(TENANT_OWNED_MODELS.has('LedgerRelation'));
});

test('不带 tenantId 建资产时按创建人补租户；关系按 fromId 补租户', async () => {
  const platform = await db.ledgerAsset.create({
    data: { type: 'platform', name: '补租户平台', createdById: userA },
  });
  assert.equal(platform.tenantId, tenantA);
  assert.deepEqual(platform.attrs, {});
  assert.deepEqual(platform.tags, []);
  const model = await db.ledgerAsset.create({
    data: { tenantId: tenantA, type: 'model', name: '补租户模型' },
  });
  const rel = await db.ledgerRelation.create({
    data: { fromId: platform.id, toId: model.id, kind: 'uses' },
  });
  assert.equal(rel.tenantId, tenantA);
});

test('关系指向别的租户的资产、资产关联别的租户的终端或组织时触发器报错', async () => {
  const mine = await db.ledgerAsset.create({
    data: { tenantId: tenantA, type: 'platform', name: '跨租户源' },
  });
  const theirs = await db.ledgerAsset.create({
    data: { tenantId: tenantB, type: 'model', name: '跨租户目标' },
  });
  await assert.rejects(
    db.ledgerRelation.create({ data: { fromId: mine.id, toId: theirs.id, kind: 'uses' } }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );
  // 显式写了本租户、但源资产是别的租户的
  await assert.rejects(
    db.ledgerRelation.create({
      data: { tenantId: tenantB, fromId: mine.id, toId: theirs.id, kind: 'uses' },
    }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );

  const epB = await endpoint(tenantB, 'c1-ledger-host-b');
  await assert.rejects(
    db.ledgerAsset.create({
      data: { tenantId: tenantA, type: 'server', name: '跨租户服务器', fleetEndpointId: epB.id },
    }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );
  const server = await db.ledgerAsset.create({
    data: { tenantId: tenantA, type: 'server', name: '后改终端的服务器' },
  });
  await assert.rejects(
    db.ledgerAsset.update({ where: { id: server.id }, data: { fleetEndpointId: epB.id } }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );

  const orgB = await db.organization.create({ data: { tenantId: tenantB, name: 'C1乙组织' } });
  await assert.rejects(
    db.ledgerAsset.create({
      data: { tenantId: tenantA, type: 'software', name: '跨租户组织', organizationId: orgB.id },
    }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );
});

test('同租户同类型重名、同租户编号重复、同一终端挂两个资产都报唯一约束错', async () => {
  await db.ledgerAsset.create({ data: { tenantId: tenantA, type: 'software', name: '重名软件' } });
  await assert.rejects(
    db.ledgerAsset.create({ data: { tenantId: tenantA, type: 'software', name: '重名软件' } }),
    isUnique,
  );
  // 不同类型、不同租户可以同名
  await db.ledgerAsset.create({ data: { tenantId: tenantA, type: 'component', name: '重名软件' } });
  await db.ledgerAsset.create({ data: { tenantId: tenantB, type: 'software', name: '重名软件' } });

  await db.ledgerAsset.create({
    data: { tenantId: tenantA, type: 'server', name: '编号一', code: 'ZC-001' },
  });
  await assert.rejects(
    db.ledgerAsset.create({
      data: { tenantId: tenantA, type: 'model', name: '编号二', code: 'ZC-001' },
    }),
    isUnique,
  );
  // 编号可空，空编号不算重复
  await db.ledgerAsset.create({ data: { tenantId: tenantA, type: 'model', name: '无编号一' } });
  await db.ledgerAsset.create({ data: { tenantId: tenantA, type: 'model', name: '无编号二' } });

  const ep = await endpoint(tenantA, 'c1-ledger-host-a');
  await db.ledgerAsset.create({
    data: { tenantId: tenantA, type: 'endpoint', name: '终端一', fleetEndpointId: ep.id },
  });
  await assert.rejects(
    db.ledgerAsset.create({
      data: { tenantId: tenantA, type: 'server', name: '终端二', fleetEndpointId: ep.id },
    }),
    isUnique,
  );
});

test('删资产时关系级联删除；终端删除后资产的关联置空', async () => {
  const a = await db.ledgerAsset.create({
    data: { tenantId: tenantA, type: 'platform', name: '级联平台' },
  });
  const b = await db.ledgerAsset.create({
    data: { tenantId: tenantA, type: 'platform', name: '级联下级' },
  });
  const c = await db.ledgerAsset.create({
    data: { tenantId: tenantA, type: 'server', name: '级联服务器' },
  });
  await db.ledgerRelation.create({ data: { fromId: a.id, toId: b.id, kind: 'contains' } });
  await db.ledgerRelation.create({ data: { fromId: b.id, toId: c.id, kind: 'deployed_on' } });
  await db.ledgerAsset.delete({ where: { id: b.id } });
  assert.equal(
    await db.ledgerRelation.count({ where: { OR: [{ fromId: b.id }, { toId: b.id }] } }),
    0,
  );

  const ep = await endpoint(tenantA, 'c1-ledger-host-gone');
  const s = await db.ledgerAsset.create({
    data: { tenantId: tenantA, type: 'server', name: '终端会被删', fleetEndpointId: ep.id },
  });
  await db.fleetEndpoint.delete({ where: { id: ep.id } });
  assert.equal(
    (await db.ledgerAsset.findUniqueOrThrow({ where: { id: s.id } })).fleetEndpointId,
    null,
  );
});

test('关系规则：platform 使用 model 允许，server 使用 model 不允许', () => {
  assert.equal(ledgerRelationAllowed('platform', 'uses', 'model'), true);
  assert.equal(ledgerRelationAllowed('server', 'uses', 'model'), false);
  assert.equal(ledgerRelationAllowed('platform', 'contains', 'platform'), true);
  assert.equal(ledgerRelationAllowed('model', 'deployed_on', 'endpoint'), true);
  assert.equal(ledgerRelationAllowed('model', 'deployed_on', 'platform'), false);
  for (const rule of LEDGER_RELATION_RULES) assert.ok(rule.to.length > 0);
});

test('权限点：ledger:read 给四个内置角色，ledger:manage 给 admin、tenant_admin、operator，库里一致', async () => {
  const expectManage = new Set(['admin', 'tenant_admin', 'operator']);
  for (const role of ROLE_DEFS) {
    assert.ok(role.permissions.includes('ledger:read'), `${role.name} 缺 ledger:read`);
    assert.equal(
      role.permissions.includes('ledger:manage'),
      expectManage.has(role.name),
      role.name,
    );
  }
  assert.ok(!PLATFORM_ONLY_PERMISSIONS.includes('ledger:read'));
  assert.ok(!PLATFORM_ONLY_PERMISSIONS.includes('ledger:manage'));
  const granted = async (code: string) =>
    (
      await db.rolePermission.findMany({
        where: { permission: { code } },
        select: { role: { select: { name: true } } },
      })
    )
      .map((r) => r.role.name)
      .filter((name) => ['admin', 'tenant_admin', 'operator', 'auditor'].includes(name))
      .sort();
  assert.deepEqual(await granted('ledger:read'), ['admin', 'auditor', 'operator', 'tenant_admin']);
  assert.deepEqual(await granted('ledger:manage'), ['admin', 'operator', 'tenant_admin']);
});
