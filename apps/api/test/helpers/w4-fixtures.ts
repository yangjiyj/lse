// W4（任务、报告、规则库）接口测试共用的账号与租户夹具。
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../src/db.js';
import { hashPassword } from '../../src/lib/password.js';
import { CSV_WATERMARK_PREFIX } from '../../src/lib/data-security.js';
import { parseCsv } from '../../src/lib/question-import.js';
import { skipFirstPasswordChange } from './tenant-admin.js';

export const ADMIN_PASSWORD = 'Admin@12345'; // pragma: allowlist secret
const FIXTURE_PASSWORD = 'W4Fixture@12345'; // pragma: allowlist secret

export const bearer = (token: string, tenant?: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  ...(tenant ? { 'x-lse-tenant': tenant } : {}),
});

export async function login(
  app: FastifyInstance,
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

export const adminToken = (app: FastifyInstance) => login(app, 'admin', ADMIN_PASSWORD);

/** 平台租户里建一个只带指定权限的用户（角色名、用户名都以 prefix 开头），返回令牌。 */
export async function limitedUserToken(
  app: FastifyInstance,
  prefix: string,
  permissionCodes: string[],
): Promise<string> {
  const perms = await prisma.permission.findMany({ where: { code: { in: permissionCodes } } });
  const role = await prisma.role.create({
    data: {
      name: `${prefix}role`,
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  const username = `${prefix}user`;
  await prisma.user.create({
    data: {
      username,
      displayName: username,
      passwordHash: await hashPassword(FIXTURE_PASSWORD),
      roles: { create: [{ roleId: role.id }] },
    },
  });
  return login(app, username, FIXTURE_PASSWORD);
}

/** 平台租户里建一个只挂内置角色（如 operator、auditor）的用户，返回令牌。 */
export async function builtinRoleUserToken(
  app: FastifyInstance,
  prefix: string,
  roleName: string,
): Promise<string> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  const username = `${prefix}${roleName}`;
  await prisma.user.create({
    data: {
      username,
      displayName: username,
      passwordHash: await hashPassword(FIXTURE_PASSWORD),
      roles: { create: [{ roleId: role.id }] },
    },
  });
  return login(app, username, FIXTURE_PASSWORD);
}

/** 新建一个租户和它的租户管理员，返回租户 ID 与管理员令牌。 */
export async function tenantAdmin(
  app: FastifyInstance,
  platformAdminToken: string,
  prefix: string,
): Promise<{ tenantId: string; token: string }> {
  const username = `${prefix}tadmin`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: bearer(platformAdminToken),
    payload: { name: `${prefix}tenant`, admin: { username, password: FIXTURE_PASSWORD } },
  });
  assert.equal(res.statusCode, 201, res.body);
  await skipFirstPasswordChange(username);
  return { tenantId: res.json().id as string, token: await login(app, username, FIXTURE_PASSWORD) };
}

/** 清掉 prefix 建出来的用户、角色、租户及租户下的数据。 */
export async function cleanupFixtures(prefix: string): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length) {
    await prisma.evalTask.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.questionSet.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.modelTarget.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.report.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { username: { startsWith: prefix } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: prefix } } });
  if (ids.length) await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
}

/** CSV 文本 → 行（解析时去掉 BOM，再去掉开启下载水印时的首行）。 */
export function csvRows(body: string): string[][] {
  const rows = parseCsv(body).filter((r) => r.some((c) => c !== ''));
  return rows[0]?.[0]?.startsWith(CSV_WATERMARK_PREFIX) ? rows.slice(1) : rows;
}
