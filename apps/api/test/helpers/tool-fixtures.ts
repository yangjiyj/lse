import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { prisma } from '../../src/db.js';

// 工具中心接口测试的公共夹具：临时存储目录、平台管理员、operator、auditor 和一个没有 tool:read 的用户。
// prefix 同时用作工具编码和用户名前缀，须满足工具编码规则（小写字母、数字、连字符）。

const PASSWORD = ['Tool', 'Test', '12345'].join('@');

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface ToolTestContext {
  app: Awaited<ReturnType<typeof buildApp>>;
  storageDir: string;
  tokens: { admin: string; operator: string; auditor: string; noTool: string };
  userIds: { admin: string; operator: string; auditor: string; noTool: string };
}

async function login(
  app: ToolTestContext['app'],
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function createUser(username: string, roleName: string): Promise<string> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: username,
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  return user.id;
}

export async function cleanupToolTest(prefix: string): Promise<void> {
  const users = await prisma.user.findMany({
    where: { username: { startsWith: prefix } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  await prisma.toolDownload.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.tool.deleteMany({ where: { code: { startsWith: prefix } } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ actorId: { in: userIds } }, { action: { startsWith: 'tool.' } }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: prefix } } });
}

export async function createToolTestContext(prefix: string): Promise<ToolTestContext> {
  const storageDir = mkdtempSync(join(tmpdir(), 'lse-tool-center-'));
  process.env.TOOL_STORAGE_DIR = storageDir;
  await cleanupToolTest(prefix);
  const app = await buildApp();
  await app.ready();
  const noToolRole = await prisma.role.create({
    data: { name: `${prefix}no-tool`, description: '没有工具中心权限' },
  });
  const operator = await createUser(`${prefix}operator`, 'operator');
  const auditor = await createUser(`${prefix}auditor`, 'auditor');
  const noTool = await createUser(`${prefix}notool`, noToolRole.name);
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  return {
    app,
    storageDir,
    tokens: {
      admin: await login(app, 'admin', ['Admin', '@', '12345'].join('')),
      operator: await login(app, `${prefix}operator`, PASSWORD),
      auditor: await login(app, `${prefix}auditor`, PASSWORD),
      noTool: await login(app, `${prefix}notool`, PASSWORD),
    },
    userIds: { admin: admin.id, operator, auditor, noTool },
  };
}

export async function destroyToolTestContext(
  ctx: ToolTestContext | undefined,
  prefix: string,
): Promise<void> {
  await cleanupToolTest(prefix);
  if (ctx) {
    await ctx.app.close();
    rmSync(ctx.storageDir, { recursive: true, force: true });
  }
}

/** 等存储目录里同时出现 n 个半截文件（*.part）：说明上传请求已过了前置检查、开始写盘。 */
export async function waitForParts(dir: string, n: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (readdirSync(dir).filter((f) => f.endsWith('.part')).length < n) {
    if (Date.now() > deadline) throw new Error(`等不到 ${n} 个 .part 文件`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 直接在库里建一个工具（不经接口），版本只写记录、不落文件。 */
export async function seedTool(
  prefix: string,
  name: string,
  opts: {
    category?: string;
    hidden?: boolean;
    enabled?: boolean;
    versions?: Array<{ version: string; os: string; arch: string }>;
  } = {},
) {
  const code = `${prefix}${name}`;
  return prisma.tool.create({
    data: {
      code,
      name: code,
      category: opts.category ?? 'model',
      hidden: opts.hidden ?? false,
      enabled: opts.enabled ?? true,
      versions: {
        create: (opts.versions ?? []).map((v, i, all) => ({
          ...v,
          createdAt: new Date(Date.now() - (all.length - i) * 1000),
          filename: `${code}-${v.os}-${v.arch}.bin`,
          size: 10n + BigInt(i),
          sha256: 'a'.repeat(64),
          storageKey: crypto.randomUUID(),
        })),
      },
    },
    include: { versions: true },
  });
}
