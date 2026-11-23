import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { ROLE_DEFS, PERMISSION_CODES } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

// ① G3 管理员收敛：网关审计日志分析（/analyze，会携带内部令牌出站）属于敏感操作，
// 只允许 admin 执行；operator / auditor 不得获得 gateway_log:analyze。

const GATEWAY_ANALYZE = 'gateway_log:analyze';
const PREFIX = '__gwperm_';
const OPERATOR_USERNAME = `${PREFIX}operator`;
const OPERATOR_PASSWORD = ['Operator', 'RBAC2', '123'].join('@');
const ADMIN_PASSWORD = ['Admin', '@', '12345'].join('');

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
let operatorToken = '';
let targetId = '';
let originalInternalToken: string | undefined;
let originalAllowlist: string | undefined;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: OPERATOR_USERNAME } });
}

function analyzePayload() {
  return {
    modelTargetId: targetId,
    name: `${PREFIX}analyze`,
    startTime: '2026-06-10T00:00:00Z',
    endTime: '2026-06-10T02:00:00Z',
    limit: 10,
  };
}

before(async () => {
  originalInternalToken = process.env.NEWAPI_EVAL_INTEGRATION_TOKEN;
  originalAllowlist = process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST;
  delete process.env.NEWAPI_EVAL_INTEGRATION_TOKEN;
  delete process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST;

  app = await buildApp();
  await app.ready();
  await cleanup();

  const operatorRole = await prisma.role.findUniqueOrThrow({ where: { name: 'operator' } });
  await prisma.user.create({
    data: {
      username: OPERATOR_USERNAME,
      passwordHash: await argon2.hash(OPERATOR_PASSWORD, { type: argon2.argon2id }),
      displayName: 'RBAC2 测试操作员',
      isActive: true,
      roles: { create: { roleId: operatorRole.id } },
    },
  });

  const target = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}智能体网关日志源`,
      targetType: 'GATEWAY_LOG',
      provider: 'newapi-agent-security-gateway',
      baseUrl: 'https://placeholder.invalid/admin/v1',
      apiKey: '',
      model: 'gateway-log-source',
      accessConfig: {
        controlPlaneBaseUrl: 'https://placeholder.invalid/admin/v1',
        tenantId: 'tenant-a',
      },
    },
  });
  targetId = target.id;

  const adminLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ADMIN_PASSWORD },
  });
  assert.equal(adminLogin.statusCode, 200, adminLogin.body);
  adminToken = adminLogin.json().token;

  const operatorLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: OPERATOR_USERNAME, password: OPERATOR_PASSWORD },
  });
  assert.equal(operatorLogin.statusCode, 200, operatorLogin.body);
  operatorToken = operatorLogin.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  if (originalInternalToken === undefined) {
    delete process.env.NEWAPI_EVAL_INTEGRATION_TOKEN;
  } else {
    process.env.NEWAPI_EVAL_INTEGRATION_TOKEN = originalInternalToken;
  }
  if (originalAllowlist === undefined) {
    delete process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST;
  } else {
    process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST = originalAllowlist;
  }
  await prisma.$disconnect();
});

function permsOf(roleName: string): string[] {
  const role = ROLE_DEFS.find((r) => r.name === roleName);
  assert.ok(role, `内置角色不存在：${roleName}`);
  return role!.permissions;
}

test('权限目录登记了 gateway_log:analyze', () => {
  assert.ok(
    PERMISSION_CODES.includes(GATEWAY_ANALYZE),
    'PERMISSION_CODES 应包含 gateway_log:analyze',
  );
});

test('不再保留 super_admin 内置角色', () => {
  assert.equal(
    ROLE_DEFS.some((r) => r.name === 'super_admin'),
    false,
  );
});

test('admin 拥有 gateway_log:analyze', () => {
  assert.ok(permsOf('admin').includes(GATEWAY_ANALYZE));
});

test('operator 不得拥有 gateway_log:analyze（管理员收敛）', () => {
  assert.ok(!permsOf('operator').includes(GATEWAY_ANALYZE));
});

test('auditor 不得拥有 gateway_log:analyze（管理员收敛）', () => {
  assert.ok(!permsOf('auditor').includes(GATEWAY_ANALYZE));
});

test('operator 调用 POST /api/gateway-logs/analyze 应得 403', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/gateway-logs/analyze',
    headers: auth(operatorToken),
    payload: analyzePayload(),
  });

  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error.code, 'FORBIDDEN');
});

test('admin 调用 POST /api/gateway-logs/analyze 进入业务校验而不是 403', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/gateway-logs/analyze',
    headers: auth(adminToken),
    payload: analyzePayload(),
  });

  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().error.code, 'GATEWAY_AUDIT_TOKEN_REQUIRED');
});
