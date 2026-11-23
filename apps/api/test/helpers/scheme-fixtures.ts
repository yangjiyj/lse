import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { prismaUnscoped as db } from '../../src/db.js';

// 检测方案、应用台账接口测试共用的夹具：两个新租户（各一个租户管理员，A 另有操作员、审计员），测完连租户一起删。

const PASSWORD = ['Scheme', 'Test', '12345'].join('@');

export interface SchemeFixture {
  tenantA: string;
  tenantB: string;
  adminA: string;
  adminB: string;
  operatorA: string;
  auditorA: string;
}

export async function cleanupSchemeTenants(
  tenantPrefix: string,
  userPrefix: string,
): Promise<void> {
  const tenants = await db.tenant.findMany({
    where: { name: { startsWith: tenantPrefix } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await db.detectJob.deleteMany({ where: { tenantId: { in: ids } } });
  await db.evalTask.deleteMany({ where: { tenantId: { in: ids } } });
  await db.question.deleteMany({ where: { questionSet: { tenantId: { in: ids } } } });
  await db.questionSet.deleteMany({ where: { tenantId: { in: ids } } });
  await db.detectScheme.deleteMany({ where: { tenantId: { in: ids } } });
  await db.ledgerAsset.deleteMany({ where: { tenantId: { in: ids } } });
  await db.fleetEndpoint.deleteMany({ where: { tenantId: { in: ids } } });
  await db.modelTarget.deleteMany({ where: { tenantId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
  await db.user.deleteMany({ where: { username: { startsWith: userPrefix } } });
  await db.tenant.deleteMany({ where: { id: { in: ids } } });
}

export async function createUser(
  tenantId: string,
  username: string,
  roleName: string,
): Promise<void> {
  const role = await db.role.findUniqueOrThrow({ where: { name: roleName } });
  await db.user.create({
    data: {
      tenantId,
      username,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: username,
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
}

export async function loginAs(app: FastifyInstance, username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

/** 建两个租户和账号，返回租户 id 和各账号的登录令牌。code 前缀要全库唯一。 */
export async function setupSchemeTenants(
  app: FastifyInstance,
  tenantPrefix: string,
  userPrefix: string,
  code: string,
): Promise<SchemeFixture> {
  await cleanupSchemeTenants(tenantPrefix, userPrefix);
  const tenantA = (
    await db.tenant.create({ data: { name: `${tenantPrefix}A`, code: `${code}-a` } })
  ).id;
  const tenantB = (
    await db.tenant.create({ data: { name: `${tenantPrefix}B`, code: `${code}-b` } })
  ).id;
  await createUser(tenantA, `${userPrefix}admin_a`, 'tenant_admin');
  await createUser(tenantB, `${userPrefix}admin_b`, 'tenant_admin');
  await createUser(tenantA, `${userPrefix}operator_a`, 'operator');
  await createUser(tenantA, `${userPrefix}auditor_a`, 'auditor');
  return {
    tenantA,
    tenantB,
    adminA: await loginAs(app, `${userPrefix}admin_a`),
    adminB: await loginAs(app, `${userPrefix}admin_b`),
    operatorA: await loginAs(app, `${userPrefix}operator_a`),
    auditorA: await loginAs(app, `${userPrefix}auditor_a`),
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** 直接写库建台账资产（夹具用）。 */
export function ledgerAsset(
  tenantId: string,
  data: {
    type: string;
    name: string;
    attrs?: Record<string, unknown>;
    fleetEndpointId?: string;
    modelTargetId?: string;
    code?: string;
    ownerName?: string;
  },
) {
  return db.ledgerAsset.create({
    data: { tenantId, ...data, attrs: (data.attrs ?? {}) as object },
  });
}

export function fleetEndpoint(tenantId: string, hostname: string) {
  return db.fleetEndpoint.create({
    data: {
      tenantId,
      publicId: `ep_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      installationId: randomUUID(),
      machineId: 'm'.repeat(32),
      hostname,
      os: 'linux',
      tokenHash: randomUUID(),
      lastSeenAt: new Date(),
    },
  });
}

export function modelTarget(tenantId: string, name: string, targetType: string) {
  return db.modelTarget.create({
    data: {
      tenantId,
      name,
      provider: 'openai-compatible',
      targetType: targetType as never,
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'x',
      model: `${name}-model`,
    },
  });
}
