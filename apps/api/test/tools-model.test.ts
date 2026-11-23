import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { BUILTIN_PROBE_TOOL_CODE, PLATFORM_ONLY_PERMISSIONS, ROLE_DEFS } from '@lse/shared';
import { prisma } from '../src/db.js';
import { ensureBuiltinTools } from '../src/modules/tools/builtin-seed.js';

// 工具中心数据模型（A-1）：内置终端探针、code 唯一、版本唯一约束、权限点。

const P = '__a1-tool-';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

after(async () => {
  await prisma.tool.deleteMany({ where: { code: { startsWith: P } } });
  await prisma.$disconnect();
});

test('迁移和种子之后存在内置「终端探针」', async () => {
  const probe = await prisma.tool.findUnique({ where: { code: BUILTIN_PROBE_TOOL_CODE } });
  assert.ok(probe, '缺少内置终端探针');
  assert.equal(probe.builtin, true);
  assert.equal(probe.category, 'app_env');
  assert.equal(probe.taskEntry, 'fleet-onboard');
  assert.equal(probe.enabled, true);
  assert.ok(probe.name.length > 0);
});

test('种子可重复执行，不覆盖管理员改过的说明和隐藏状态', async () => {
  const before = await prisma.tool.findUniqueOrThrow({ where: { code: BUILTIN_PROBE_TOOL_CODE } });
  try {
    await prisma.tool.update({
      where: { id: before.id },
      data: { instructions: '管理员改过的说明', hidden: true, enabled: false },
    });
    await ensureBuiltinTools(prisma);
    await ensureBuiltinTools(prisma);
    const after = await prisma.tool.findUniqueOrThrow({ where: { id: before.id } });
    assert.equal(after.instructions, '管理员改过的说明');
    assert.equal(after.hidden, true);
    assert.equal(after.enabled, true, '内置工具不能处于禁用状态');
    assert.equal(after.builtin, true);
    assert.equal(await prisma.tool.count({ where: { code: BUILTIN_PROBE_TOOL_CODE } }), 1);
  } finally {
    await prisma.tool.update({
      where: { id: before.id },
      data: { instructions: before.instructions, hidden: before.hidden, enabled: before.enabled },
    });
  }
});

test('工具 code 唯一', async () => {
  const code = `${P}${randomUUID().slice(0, 8)}`;
  await prisma.tool.create({ data: { code, name: '甲', category: 'model' } });
  await assert.rejects(
    prisma.tool.create({ data: { code, name: '乙', category: 'data' } }),
    isUniqueViolation,
  );
});

test('同一工具的同版本、同系统、同架构只能有一个文件', async () => {
  const tool = await prisma.tool.create({
    data: { code: `${P}${randomUUID().slice(0, 8)}`, name: '版本约束', category: 'model' },
  });
  const version = (arch: string) => ({
    toolId: tool.id,
    version: '1.0.0',
    os: 'linux',
    arch,
    filename: 'a.tar.gz',
    size: 3n,
    sha256: 'a'.repeat(64),
    storageKey: randomUUID(),
  });
  await prisma.toolVersion.create({ data: version('amd64') });
  await assert.rejects(prisma.toolVersion.create({ data: version('amd64') }), isUniqueViolation);
  await prisma.toolVersion.create({ data: version('arm64') });
  assert.equal(await prisma.toolVersion.count({ where: { toolId: tool.id } }), 2);
});

test('tool:read 给全部预设角色，tool:manage 只给平台管理员且是平台级权限', async () => {
  for (const role of ROLE_DEFS) {
    assert.ok(role.permissions.includes('tool:read'), `${role.name} 缺 tool:read`);
    assert.equal(role.permissions.includes('tool:manage'), role.name === 'admin', role.name);
  }
  assert.ok(PLATFORM_ONLY_PERMISSIONS.includes('tool:manage'));
  assert.ok(!PLATFORM_ONLY_PERMISSIONS.includes('tool:read'));
  const granted = async (code: string) =>
    (
      await prisma.rolePermission.findMany({
        where: { permission: { code } },
        select: { role: { select: { name: true } } },
      })
    )
      .map((r) => r.role.name)
      .sort();
  assert.deepEqual(await granted('tool:manage'), ['admin']);
  for (const name of ['admin', 'tenant_admin', 'operator', 'auditor']) {
    assert.ok((await granted('tool:read')).includes(name), `库里 ${name} 缺 tool:read`);
  }
});
