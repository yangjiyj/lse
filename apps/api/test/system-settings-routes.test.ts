import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { RED_TEAM_SETTING_KEY } from '../src/modules/red-team/config.js';

const USERNAME = 'system_settings_auditor';
const PASSWORD = ['Sys', 'Setting', '12345'].join('!');
const ORIGINAL_GATEWAY_ALLOWLIST = process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST;
const ROLE_TARGET_IDS = [
  'attacker-base',
  'attacker-ok',
  'judge-001',
  'perm-test-attacker',
  'inactive-attacker',
  'unsupported-attacker',
  'incomplete-attacker',
];

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
let auditorToken = '';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { action: 'system_setting.update' } });
  await prisma.systemSetting.deleteMany({
    where: { key: { in: ['access', 'audit', 'gateway', RED_TEAM_SETTING_KEY] } },
  });
  await prisma.modelTarget.deleteMany({ where: { id: { in: ROLE_TARGET_IDS } } });
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  await prisma.user.deleteMany({ where: { username: { startsWith: '__perm_test_' } } });
  await prisma.rolePermission.deleteMany({
    where: { role: { name: { startsWith: '__perm_test_' } } },
  });
  await prisma.role.deleteMany({ where: { name: { startsWith: '__perm_test_' } } });
}

before(async () => {
  process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST = '';
  app = await buildApp();
  await app.ready();
  await cleanup();
  await prisma.modelTarget.createMany({
    data: [
      ...['attacker-base', 'attacker-ok', 'perm-test-attacker'].map((id) => ({
        id,
        name: `__system_settings_${id}`,
        targetType: 'MODEL' as const,
        provider: 'openai-compatible',
        baseUrl: 'https://model.example.test/v1',
        apiKey: 'test-api-key',
        model: `model-${id}`,
        isActive: true,
      })),
      {
        id: 'judge-001',
        name: '__system_settings_judge',
        targetType: 'JUDGE',
        provider: 'openai-compatible',
        baseUrl: 'https://judge.example.test/v1',
        apiKey: 'test-api-key',
        model: 'judge-model',
        isActive: true,
      },
      {
        id: 'inactive-attacker',
        name: '__system_settings_inactive',
        targetType: 'MODEL',
        provider: 'openai-compatible',
        baseUrl: 'https://inactive.example.test/v1',
        apiKey: 'test-api-key',
        model: 'inactive-model',
        isActive: false,
      },
      {
        id: 'unsupported-attacker',
        name: '__system_settings_unsupported',
        targetType: 'AGENT_API',
        provider: 'openai-compatible',
        baseUrl: 'https://agent.example.test/v1',
        apiKey: 'test-api-key',
        model: 'agent-model',
        isActive: true,
      },
      {
        id: 'incomplete-attacker',
        name: '__system_settings_incomplete',
        targetType: 'MODEL',
        provider: 'openai-compatible',
        baseUrl: 'https://incomplete.example.test/v1',
        apiKey: '',
        model: 'incomplete-model',
        isActive: true,
      },
    ],
  });

  const adminLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(adminLogin.statusCode, 200, adminLogin.body);
  adminToken = adminLogin.json().token;

  const auditorRole = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await prisma.user.create({
    data: {
      username: USERNAME,
      passwordHash,
      displayName: '系统设置审计员',
      isActive: true,
      roles: { create: { roleId: auditorRole.id } },
    },
  });
  const auditorLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: USERNAME, password: PASSWORD },
  });
  assert.equal(auditorLogin.statusCode, 200, auditorLogin.body);
  auditorToken = auditorLogin.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
  if (ORIGINAL_GATEWAY_ALLOWLIST === undefined) delete process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST;
  else process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST = ORIGINAL_GATEWAY_ALLOWLIST;
});

test('未认证不能读取平台运行配置', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/system-settings' });
  assert.equal(res.statusCode, 401);
});

test('管理员可以读取默认平台运行配置', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: bearer(adminToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.audit.retentionDays, 180);
  assert.equal(body.audit.operationAudit, true);
  assert.match(body.access.encryptedLoginUrl, /^https:\/\//);
  assert.equal(body.gateway.gatewayBaseUrl, '');
  assert.equal(body.gateway.gatewayLinkageEnabled, false);
  assert.equal(typeof body.gateway.secretConfigured, 'boolean');
});

test('管理员可开启网关联动开关并持久化（默认关）', async () => {
  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { gateway: { gatewayLinkageEnabled: true } },
  });
  assert.equal(patch.statusCode, 200, patch.body);
  assert.equal(patch.json().gateway.gatewayLinkageEnabled, true);

  const res = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: bearer(adminToken),
  });
  assert.equal(res.json().gateway.gatewayLinkageEnabled, true);

  await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { gateway: { gatewayLinkageEnabled: false } },
  });
});

test('管理员可以保存审计留存配置并写入审计日志', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: {
      audit: {
        operationAudit: true,
        evidenceRetention: '请求、响应、判定结果、交付报告',
        logRedaction: '严格脱敏',
        retentionDays: 365,
        externalArchive: true,
        archiveTarget: '集团审计归档库',
      },
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().audit.retentionDays, 365);
  assert.equal(res.json().audit.archiveTarget, '集团审计归档库');

  const reload = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: bearer(adminToken),
  });
  assert.equal(reload.statusCode, 200, reload.body);
  assert.equal(reload.json().audit.retentionDays, 365);

  assert.ok(
    await prisma.auditLog.findFirst({
      where: { action: 'system_setting.update', targetType: 'system_setting' },
    }),
  );
});

test('审计员不能更新平台运行配置', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(auditorToken),
    payload: { gateway: { gatewayBaseUrl: 'http://control-plane:8081' } },
  });
  assert.equal(res.statusCode, 403);
});

test('管理员保存网关全局默认地址并回读', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { gateway: { gatewayBaseUrl: 'http://control-plane:8081' } },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().gateway.gatewayBaseUrl, 'http://control-plane:8081');
  assert.equal(typeof res.json().gateway.secretConfigured, 'boolean');
});

test('网关地址未获部署授权时拒绝保存并返回可操作提示', async () => {
  const previousAllowlist = process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST;
  const previous = await prisma.systemSetting.findUnique({ where: { key: 'gateway' } });
  process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST = 'http://allowed-gateway.internal:8080';
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/system-settings',
      headers: bearer(adminToken),
      payload: { gateway: { gatewayBaseUrl: 'http://blocked-gateway.internal:8080' } },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().error.code, 'GATEWAY_ADDRESS_NOT_AUTHORIZED');
    assert.match(res.json().error.message, /当前网关地址未获部署授权/);
  } finally {
    if (previousAllowlist === undefined) delete process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST;
    else process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST = previousAllowlist;
    if (previous) {
      await prisma.systemSetting.update({
        where: { key: 'gateway' },
        data: { value: previous.value },
      });
    } else {
      await prisma.systemSetting.deleteMany({ where: { key: 'gateway' } });
    }
  }
});

test('读取设置时明确返回当前网关地址的部署授权状态', async () => {
  const previousAllowlist = process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST;
  const previous = await prisma.systemSetting.findUnique({ where: { key: 'gateway' } });
  process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST = 'http://allowed-gateway.internal:8080';
  try {
    await prisma.systemSetting.upsert({
      where: { key: 'gateway' },
      update: { value: { gatewayBaseUrl: 'http://blocked-gateway.internal:8080' } },
      create: { key: 'gateway', value: { gatewayBaseUrl: 'http://blocked-gateway.internal:8080' } },
    });
    const blocked = await app.inject({
      method: 'GET',
      url: '/api/system-settings',
      headers: bearer(adminToken),
    });
    assert.equal(blocked.statusCode, 200, blocked.body);
    assert.equal(blocked.json().gateway.addressAuthorization, 'NOT_AUTHORIZED');
  } finally {
    if (previousAllowlist === undefined) delete process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST;
    else process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST = previousAllowlist;
    if (previous) {
      await prisma.systemSetting.update({
        where: { key: 'gateway' },
        data: { value: previous.value },
      });
    } else {
      await prisma.systemSetting.deleteMany({ where: { key: 'gateway' } });
    }
  }
});

test('网关连通自检：不可达网关返回 ok:false', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/system-settings/gateway/test',
    headers: bearer(adminToken),
    payload: { gatewayBaseUrl: 'http://gw-unreachable.invalid:9' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ok, false);
});

test('管理员可以读取默认红队策略配置', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: bearer(adminToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.redteam.breakOn, 'verdict');
  assert.equal(body.redteam.maxRounds, 6);
  assert.equal(body.redteam.noProgressK, 3);
  assert.equal(body.redteam.judgeTargetId, '');
  assert.equal(body.updatedAt.redteam, null);
});

test('完整的独立判定模型可保存为主攻击模型', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { redteam: { attackerTargetId: 'judge-001' } },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().redteam.attackerTargetId, 'judge-001');
});

test('不存在、停用、非模型类型或配置不完整的角色模型引用被拒绝', async () => {
  const cases = [
    {
      payload: { redteam: { attackerTargetId: 'missing-attacker' } },
      code: 'RED_TEAM_TARGET_NOT_FOUND',
    },
    {
      payload: { redteam: { attackerTargetId: 'inactive-attacker' } },
      code: 'RED_TEAM_TARGET_INACTIVE',
    },
    {
      payload: { redteam: { attackerTargetId: 'unsupported-attacker' } },
      code: 'RED_TEAM_TARGET_NOT_CALLABLE',
    },
    {
      payload: { redteam: { attackerTargetId: 'incomplete-attacker' } },
      code: 'RED_TEAM_TARGET_NOT_CALLABLE',
    },
    {
      payload: {
        redteam: {
          attackerTargetId: 'attacker-base',
          secondaryAttackerTargetId: 'missing-attacker',
        },
      },
      code: 'RED_TEAM_TARGET_NOT_FOUND',
    },
    {
      payload: { agent_eval: { attackerTargetId: 'unsupported-attacker' } },
      code: 'RED_TEAM_TARGET_NOT_CALLABLE',
    },
  ];

  for (const entry of cases) {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/system-settings',
      headers: bearer(adminToken),
      payload: entry.payload,
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, entry.code, res.body);
  }
});

test('保存红队策略以 redteam.config 键持久化，budgetTokens 作为一等字段保留', async () => {
  // 1) 首次保存：必须带上 attackerTargetId（合并后整体校验要求非空）
  const first = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { redteam: { attackerTargetId: 'attacker-base', maxRounds: 6, budgetTokens: 4096 } },
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().redteam.budgetTokens, 4096);

  // 2) PATCH 别的字段；budgetTokens 必须保留（schema 字段，合并后仍在）
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { redteam: { breakOn: 'attitude', judgeTargetId: 'judge-001', maxRounds: 8 } },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().redteam.breakOn, 'attitude');
  assert.equal(res.json().redteam.judgeTargetId, 'judge-001');
  assert.equal(res.json().redteam.maxRounds, 8);
  assert.equal(res.json().redteam.budgetTokens, 4096); // schema 字段保留

  const row = await prisma.systemSetting.findUnique({ where: { key: RED_TEAM_SETTING_KEY } });
  assert.ok(row, 'redteam.config 行应存在');
  const stored = row!.value as Record<string, unknown>;
  assert.equal(stored.breakOn, 'attitude');
  assert.equal(stored.judgeTargetId, 'judge-001');
  assert.equal(stored.budgetTokens, 4096); // schema 一等字段保留

  const reload = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: bearer(adminToken),
  });
  assert.equal(reload.json().redteam.breakOn, 'attitude');
  assert.equal(reload.json().redteam.budgetTokens, 4096);
});

test('红队策略最大轮数少于 5 被拒绝', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { redteam: { attackerTargetId: 'attacker-base', maxRounds: 3 } },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('历史红队策略存量轮数小于 5 时兼容读取并提升为 5', async () => {
  await prisma.systemSetting.upsert({
    where: { key: RED_TEAM_SETTING_KEY },
    create: { key: RED_TEAM_SETTING_KEY, value: { attackerTargetId: 'attacker-base', maxRounds: 3 } },
    update: { value: { attackerTargetId: 'attacker-base', maxRounds: 3 } },
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: bearer(adminToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().redteam.maxRounds, 5);
});

test('非法 breakOn 被拒绝', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { redteam: { attackerTargetId: 'attacker-base', breakOn: 'nonsense' } },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('agent_eval.noProgressK 写入并回读（任务 1）', async () => {
  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { agent_eval: { noProgressK: 5 } },
  });
  assert.equal(patch.statusCode, 200, patch.body);
  const reload = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: bearer(adminToken),
  });
  assert.equal(reload.json().agent_eval.noProgressK, 5);
});

test('红队策略 attackerTargetId 为空字符串时 PATCH 被拒（自主红队必须有主出招 AI）', async () => {
  // 先写入一个合法的 redteam.config（带 attackerTargetId）
  const ok = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { redteam: { attackerTargetId: 'attacker-ok', judgeTargetId: 'judge-001' } },
  });
  assert.equal(ok.statusCode, 200, ok.body);

  // 再用空字符串覆盖 attackerTargetId，必须 400
  const rejected = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { redteam: { attackerTargetId: '' } },
  });
  assert.equal(rejected.statusCode, 400, rejected.body);
});

test('redteam PATCH 不应把外部传入的 agent_eval 字段持久化进 redteam.config', async () => {
  // 模拟前端 bug：redteam body 里夹带了 agent_eval 子对象
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: {
      redteam: {
        attackerTargetId: 'attacker-ok',
        agent_eval: { attackerTargetId: 'should-not-leak', enabled: true },
      },
    },
  });
  assert.equal(res.statusCode, 200, res.body);

  const row = await prisma.systemSetting.findUnique({ where: { key: RED_TEAM_SETTING_KEY } });
  assert.ok(row, 'redteam.config 行应存在');
  const stored = row!.value as Record<string, unknown>;
  assert.equal(stored.attackerTargetId, 'attacker-ok');
  // agent_eval 不应泄漏进 redteam.config（它是独立的 agent_eval.config 键）
  assert.equal(
    (stored as Record<string, unknown>).agent_eval,
    undefined,
    'redteam.config 不应包含 agent_eval 子对象',
  );
});

const PERM_TEST_PREFIX = '__perm_test_';

async function createPermTestUser(username: string, permissionCodes: string[]): Promise<string> {
  const roleName = PERM_TEST_PREFIX + username;
  for (const code of permissionCodes) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, name: code, group: '系统管理' },
      update: {},
    });
  }
  const role = await prisma.role.create({
    data: { name: roleName, description: '权限拆分测试', isBuiltin: false },
  });
  const perms = await prisma.permission.findMany({
    where: { code: { in: permissionCodes } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
  });
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await prisma.user.create({
    data: {
      username,
      passwordHash,
      displayName: username,
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  return login.json().token;
}

const validRedteamPatch = { redteam: { attackerTargetId: 'perm-test-attacker' } };
const validAccessPatch = { access: { loginPolicy: '权限拆分测试策略' } };

test('权限拆分：只有 redteam_setting:update 的用户可改 redteam，不能改 access/gateway', async () => {
  const token = await createPermTestUser('__perm_test_redteam_only', ['redteam_setting:update']);
  const okRedteam = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(token),
    payload: validRedteamPatch,
  });
  assert.equal(okRedteam.statusCode, 200, okRedteam.body);

  const denyAccess = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(token),
    payload: validAccessPatch,
  });
  assert.equal(denyAccess.statusCode, 403, denyAccess.body);

  const denyGateway = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(token),
    payload: { gateway: { gatewayBaseUrl: 'http://forbidden.invalid:9' } },
  });
  assert.equal(denyGateway.statusCode, 403, denyGateway.body);
});

test('权限拆分：只有 platform_setting:update 的用户可改 access，不能改 redteam', async () => {
  const token = await createPermTestUser('__perm_test_platform_only', ['platform_setting:update']);
  const okAccess = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(token),
    payload: validAccessPatch,
  });
  assert.equal(okAccess.statusCode, 200, okAccess.body);

  const denyRedteam = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(token),
    payload: validRedteamPatch,
  });
  assert.equal(denyRedteam.statusCode, 403, denyRedteam.body);
});

test('权限拆分：有旧 system_setting:update 的用户（admin）任何组都能改（向后兼容）', async () => {
  const accessRes = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: validAccessPatch,
  });
  assert.equal(accessRes.statusCode, 200, accessRes.body);

  const redteamRes = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: validRedteamPatch,
  });
  assert.equal(redteamRes.statusCode, 200, redteamRes.body);

  const gatewayRes = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { gateway: { gatewayBaseUrl: 'http://compat.invalid:9' } },
  });
  assert.equal(gatewayRes.statusCode, 200, gatewayRes.body);
});

test('权限拆分：GET 路由或语义——有 platform_setting:read 但无 redteam_setting:read 也能读', async () => {
  const token = await createPermTestUser('__perm_test_read_platform_only', [
    'platform_setting:read',
  ]);
  const res = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: bearer(token),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(typeof res.json().redteam, 'object');
});

test('权限拆分：无任何 setting 读权限的用户 GET 被拒（403）', async () => {
  const token = await createPermTestUser('__perm_test_no_read', ['eval_task:read']);
  const res = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: bearer(token),
  });
  assert.equal(res.statusCode, 403, res.body);
});
