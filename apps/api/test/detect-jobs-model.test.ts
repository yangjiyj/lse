import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { ROLE_DEFS } from '@lse/shared';
import { prismaUnscoped } from '../src/db.js';
import { PLATFORM_TENANT_ID, TENANT_OWNED_MODELS } from '../src/lib/tenant-models.js';

// B-1 组合任务与检测策略的数据模型（2.4.9、2.4.3）：租户补齐、跨租户引用守卫、唯一约束、级联、权限点。

const P = '__p2bb_model_';
const TENANT_PREFIX = 'P2BB组合任务模型测试';
let tenantA = '';
let tenantB = '';
let userA = '';

async function cleanup(): Promise<void> {
  await prismaUnscoped.detectJob.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.detectStrategy.deleteMany({ where: { name: { startsWith: P } } });
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: { startsWith: TENANT_PREFIX } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await prismaUnscoped.detectJob.deleteMany({ where: { tenantId: { in: ids } } });
  await prismaUnscoped.detectStrategy.deleteMany({ where: { tenantId: { in: ids } } });
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: P } } });
  await prismaUnscoped.tenant.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  await cleanup();
  tenantA = (
    await prismaUnscoped.tenant.create({
      data: { name: `${TENANT_PREFIX}A`, code: 'p2bb-model-a' },
    })
  ).id;
  tenantB = (
    await prismaUnscoped.tenant.create({
      data: { name: `${TENANT_PREFIX}B`, code: 'p2bb-model-b' },
    })
  ).id;
  userA = (
    await prismaUnscoped.user.create({
      data: { tenantId: tenantA, username: `${P}ua`, passwordHash: 'x', displayName: 'ua' },
    })
  ).id;
});

after(async () => {
  await cleanup();
});

test('三个模型登记为租户内数据', () => {
  for (const model of ['DetectStrategy', 'DetectJob', 'DetectJobItem']) {
    assert.ok(TENANT_OWNED_MODELS.has(model), model);
  }
});

test('不带租户写入：策略、组合任务按创建人补租户，子任务按组合任务补；没有创建人归平台租户', async () => {
  const strategy = await prismaUnscoped.detectStrategy.create({
    data: { name: `${P}补租户策略`, items: [], createdById: userA },
  });
  assert.equal(strategy.tenantId, tenantA);
  assert.equal(strategy.maxParallel, 4);
  assert.equal(strategy.timezone, 'Asia/Shanghai');
  assert.equal(strategy.minIntervalMinutes, 60);
  assert.equal(strategy.enabled, true);

  const job = await prismaUnscoped.detectJob.create({
    data: { name: `${P}补租户`, createdById: userA, strategyId: strategy.id },
  });
  assert.equal(job.tenantId, tenantA);
  assert.equal(job.status, 'PENDING');
  assert.equal(job.triggeredBy, 'manual');
  assert.equal(job.stopRequested, false);

  const item = await prismaUnscoped.detectJobItem.create({
    data: { jobId: job.id, position: 0, kind: 'eval_task', title: '子任务', params: {} },
  });
  assert.equal(item.tenantId, tenantA);
  assert.equal(item.status, 'PENDING');
  assert.equal(item.recordId, null);

  const orphan = await prismaUnscoped.detectJob.create({ data: { name: `${P}无创建人` } });
  assert.equal(orphan.tenantId, PLATFORM_TENANT_ID);
});

test('组合任务引用别的租户的策略：数据库拒绝（新建和改引用都拒绝）', async () => {
  const foreign = await prismaUnscoped.detectStrategy.create({
    data: { tenantId: tenantB, name: `${P}别人的策略`, items: [] },
  });
  await assert.rejects(
    prismaUnscoped.detectJob.create({
      data: { tenantId: tenantA, name: `${P}跨租户`, strategyId: foreign.id },
    }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );
  const job = await prismaUnscoped.detectJob.create({
    data: { tenantId: tenantA, name: `${P}后改引用` },
  });
  await assert.rejects(
    prismaUnscoped.detectJob.update({ where: { id: job.id }, data: { strategyId: foreign.id } }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );
  const own = await prismaUnscoped.detectStrategy.create({
    data: { tenantId: tenantA, name: `${P}自己的策略`, items: [] },
  });
  const ok = await prismaUnscoped.detectJob.update({
    where: { id: job.id },
    data: { strategyId: own.id },
  });
  assert.equal(ok.strategyId, own.id);
});

test('同一组合任务里子任务序号重复：唯一约束报错', async () => {
  const job = await prismaUnscoped.detectJob.create({
    data: { tenantId: tenantA, name: `${P}序号重复` },
  });
  await prismaUnscoped.detectJobItem.create({
    data: { jobId: job.id, position: 1, kind: 'eval_task', title: 'a', params: {} },
  });
  await assert.rejects(
    prismaUnscoped.detectJobItem.create({
      data: { jobId: job.id, position: 1, kind: 'corpus_scan', title: 'b', params: {} },
    }),
    (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002',
  );
});

test('删组合任务时子任务级联删除；删策略时组合任务的策略引用置空', async () => {
  const strategy = await prismaUnscoped.detectStrategy.create({
    data: { tenantId: tenantA, name: `${P}将删除的策略`, items: [] },
  });
  const job = await prismaUnscoped.detectJob.create({
    data: { tenantId: tenantA, name: `${P}级联`, strategyId: strategy.id },
  });
  await prismaUnscoped.detectJobItem.createMany({
    data: [0, 1, 2].map((position) => ({
      jobId: job.id,
      position,
      kind: 'eval_task',
      title: `子任务${position}`,
      params: {},
    })),
  });
  assert.equal(await prismaUnscoped.detectJobItem.count({ where: { jobId: job.id } }), 3);

  await prismaUnscoped.detectStrategy.delete({ where: { id: strategy.id } });
  const after = await prismaUnscoped.detectJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.strategyId, null);

  await prismaUnscoped.detectJob.delete({ where: { id: job.id } });
  assert.equal(await prismaUnscoped.detectJobItem.count({ where: { jobId: job.id } }), 0);
});

test('权限点：operator 有 detect_task:manage，auditor 只有 detect_task:read', async () => {
  const rows = await prismaUnscoped.rolePermission.findMany({
    where: { permission: { code: { startsWith: 'detect_task:' } } },
    select: { role: { select: { name: true } }, permission: { select: { code: true } } },
  });
  const byRole = new Map<string, string[]>();
  for (const r of rows) {
    byRole.set(r.role.name, [...(byRole.get(r.role.name) ?? []), r.permission.code].sort());
  }
  assert.deepEqual(byRole.get('admin'), ['detect_task:manage', 'detect_task:read']);
  assert.deepEqual(byRole.get('tenant_admin'), ['detect_task:manage', 'detect_task:read']);
  assert.deepEqual(byRole.get('operator'), ['detect_task:manage', 'detect_task:read']);
  assert.deepEqual(byRole.get('auditor'), ['detect_task:read']);

  // 共享包里的角色预设与库一致
  const preset = (name: string) =>
    ROLE_DEFS.find((r) => r.name === name)!
      .permissions.filter((c) => c.startsWith('detect_task:'))
      .sort();
  assert.deepEqual(preset('admin'), ['detect_task:manage', 'detect_task:read']);
  assert.deepEqual(preset('tenant_admin'), ['detect_task:manage', 'detect_task:read']);
  assert.deepEqual(preset('operator'), ['detect_task:manage', 'detect_task:read']);
  assert.deepEqual(preset('auditor'), ['detect_task:read']);
});
