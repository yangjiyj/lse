import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { PERMISSION_CODES, PLATFORM_ONLY_PERMISSIONS, ROLE_DEFS } from '@lse/shared';

// 2.9.11 技术支持、2.9.12 意见反馈：工单提交、查看、回复、关闭，support:manage 处理全部租户的工单。

const P = '__w6_ticket_';
const TENANT_NAME = 'W6工单测试租户';
const PASSWORD = ['Ticket', 'Test', '12345'].join('@');

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
const tokens = { a: '', b: '', tenantAdmin: '' };
const ids = { a: '', b: '', tenant: '' };

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  await prisma.supportTicket.deleteMany({ where: { title: { startsWith: P } } });
  await prisma.auditLog.deleteMany({ where: { action: { startsWith: 'support_ticket.' } } });
  const tenants = await prisma.tenant.findMany({
    where: { name: TENANT_NAME },
    select: { id: true },
  });
  const tenantIds = tenants.map((t) => t.id);
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.user.deleteMany({
    where: { OR: [{ username: { startsWith: P } }, { tenantId: { in: tenantIds } }] },
  });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function createUser(
  username: string,
  roleName: string,
): Promise<{ id: string; token: string }> {
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
  return { id: user.id, token: await login(username, PASSWORD) };
}

async function submit(token: string, kind: 'SUPPORT' | 'FEEDBACK', title: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/support-tickets',
    headers: bearer(token),
    payload: { kind, title: P + title, content: `${title}的详细描述` },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; status: string; kind: string; title: string };
}

async function reply(token: string, id: string, content: string) {
  return app.inject({
    method: 'POST',
    url: `/api/support-tickets/${id}/replies`,
    headers: bearer(token),
    payload: { content },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  adminToken = await login('admin', ['Admin', '@', '12345'].join(''));
  const a = await createUser(`${P}a`, 'operator');
  const b = await createUser(`${P}b`, 'auditor');
  tokens.a = a.token;
  tokens.b = b.token;
  ids.a = a.id;
  ids.b = b.id;

  const tenant = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: bearer(adminToken),
    payload: { name: TENANT_NAME, admin: { username: `${P}tadmin`, password: PASSWORD } },
  });
  assert.equal(tenant.statusCode, 201, tenant.body);
  ids.tenant = tenant.json().id;
  await skipFirstPasswordChange(`${P}tadmin`);
  tokens.tenantAdmin = await login(`${P}tadmin`, PASSWORD);
});

after(async () => {
  await cleanup();
  await app.close();
});

test('任何登录用户都能提交工单，并查看自己的工单和回复', async () => {
  const ticket = await submit(tokens.b, 'SUPPORT', '无法导出报告');
  assert.equal(ticket.status, 'OPEN');
  assert.equal(ticket.kind, 'SUPPORT');
  const row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
  assert.equal(row.createdById, ids.b);
  assert.equal(row.tenantId, PLATFORM_TENANT_ID);

  const feedback = await submit(tokens.b, 'FEEDBACK', '希望支持暗色模式');

  const mine = await app.inject({ url: '/api/support-tickets', headers: bearer(tokens.b) });
  assert.equal(mine.statusCode, 200, mine.body);
  const mineIds = mine.json().items.map((t: { id: string }) => t.id);
  assert.ok(mineIds.includes(ticket.id) && mineIds.includes(feedback.id));

  const onlyFeedback = await app.inject({
    url: '/api/support-tickets?kind=FEEDBACK',
    headers: bearer(tokens.b),
  });
  assert.deepEqual(
    onlyFeedback.json().items.map((t: { id: string }) => t.id),
    [feedback.id],
  );

  const replied = await reply(adminToken, ticket.id, '请升级到最新版本');
  assert.equal(replied.statusCode, 201, replied.body);

  const detail = await app.inject({
    url: `/api/support-tickets/${ticket.id}`,
    headers: bearer(tokens.b),
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().content, '无法导出报告的详细描述');
  assert.deepEqual(
    detail
      .json()
      .replies.map((r: { content: string; byCreator: boolean }) => [r.content, r.byCreator]),
    [['请升级到最新版本', false]],
  );
});

test('普通用户看不到别人的工单：列表里没有，详情和回复返回 404', async () => {
  const ticket = await submit(tokens.a, 'SUPPORT', '甲的工单');
  const list = await app.inject({ url: '/api/support-tickets', headers: bearer(tokens.b) });
  assert.ok(!list.json().items.some((t: { id: string }) => t.id === ticket.id));

  const detail = await app.inject({
    url: `/api/support-tickets/${ticket.id}`,
    headers: bearer(tokens.b),
  });
  assert.equal(detail.statusCode, 404, detail.body);
  const res = await reply(tokens.b, ticket.id, '插一句');
  assert.equal(res.statusCode, 404, res.body);

  const otherTenant = await app.inject({
    url: `/api/support-tickets/${ticket.id}`,
    headers: bearer(tokens.tenantAdmin),
  });
  assert.equal(otherTenant.statusCode, 404, otherTenant.body);
});

test('support:manage（admin）能看全部租户的工单；其他角色不能', async () => {
  const platformTicket = await submit(tokens.a, 'SUPPORT', '平台租户的工单');
  const tenantTicket = await submit(tokens.tenantAdmin, 'FEEDBACK', '其他租户的反馈');
  const row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: tenantTicket.id } });
  assert.equal(row.tenantId, ids.tenant);

  const all = await app.inject({ url: '/api/support-tickets/manage', headers: bearer(adminToken) });
  assert.equal(all.statusCode, 200, all.body);
  const items = all.json().items as Array<{ id: string; tenantName: string | null }>;
  assert.ok(items.some((t) => t.id === platformTicket.id));
  const fromTenant = items.find((t) => t.id === tenantTicket.id);
  assert.ok(fromTenant, '看得到其他租户提交的工单');
  assert.equal(fromTenant.tenantName, TENANT_NAME);

  const feedbackOnly = await app.inject({
    url: '/api/support-tickets/manage?kind=FEEDBACK',
    headers: bearer(adminToken),
  });
  assert.ok(
    feedbackOnly.json().items.every((t: { kind: string }) => t.kind === 'FEEDBACK'),
    '按类型筛选',
  );

  const detail = await app.inject({
    url: `/api/support-tickets/${tenantTicket.id}`,
    headers: bearer(adminToken),
  });
  assert.equal(detail.statusCode, 200, detail.body);

  for (const token of [tokens.a, tokens.tenantAdmin]) {
    const denied = await app.inject({ url: '/api/support-tickets/manage', headers: bearer(token) });
    assert.equal(denied.statusCode, 403, denied.body);
  }
});

test('状态流转：管理员回复→REPLIED，提交人追加→OPEN，关闭后不能再回复（409）', async () => {
  const ticket = await submit(tokens.tenantAdmin, 'SUPPORT', '状态流转');

  assert.equal((await reply(adminToken, ticket.id, '已收到')).statusCode, 201);
  assert.equal(
    (await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status,
    'REPLIED',
  );

  assert.equal((await reply(tokens.tenantAdmin, ticket.id, '还是不行')).statusCode, 201);
  assert.equal(
    (await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status,
    'OPEN',
  );

  const notManager = await app.inject({
    method: 'POST',
    url: `/api/support-tickets/${ticket.id}/close`,
    headers: bearer(tokens.tenantAdmin),
  });
  assert.equal(notManager.statusCode, 403, notManager.body);

  const closed = await app.inject({
    method: 'POST',
    url: `/api/support-tickets/${ticket.id}/close`,
    headers: bearer(adminToken),
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().status, 'CLOSED');

  for (const token of [tokens.tenantAdmin, adminToken]) {
    const res = await reply(token, ticket.id, '关闭后再回复');
    assert.equal(res.statusCode, 409, res.body);
  }
  const detail = await app.inject({
    url: `/api/support-tickets/${ticket.id}`,
    headers: bearer(tokens.tenantAdmin),
  });
  assert.equal(detail.json().status, 'CLOSED');
  assert.equal(detail.json().replies.length, 2);
});

test('同租户的租户管理员看不到本租户普通用户的工单（404）', async () => {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'operator' } });
  await prisma.user.create({
    data: {
      username: `${P}tuser`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: `${P}tuser`,
      isActive: true,
      tenantId: ids.tenant,
      roles: { create: { roleId: role.id } },
    },
  });
  const userToken = await login(`${P}tuser`, PASSWORD);
  const ticket = await submit(userToken, 'SUPPORT', '租户内普通用户的工单');
  const row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
  assert.equal(row.tenantId, ids.tenant);

  const list = await app.inject({
    url: '/api/support-tickets',
    headers: bearer(tokens.tenantAdmin),
  });
  assert.ok(!list.json().items.some((t: { id: string }) => t.id === ticket.id));
  const detail = await app.inject({
    url: `/api/support-tickets/${ticket.id}`,
    headers: bearer(tokens.tenantAdmin),
  });
  assert.equal(detail.statusCode, 404, detail.body);
  const res = await reply(tokens.tenantAdmin, ticket.id, '租户管理员插一句');
  assert.equal(res.statusCode, 404, res.body);
});

test('平台管理员代管租户时提交的工单记在本属租户，回到平台租户也看得到', async () => {
  const others = await submit(tokens.tenantAdmin, 'SUPPORT', '代管租户里别人的工单');
  const proxied = { ...bearer(adminToken), 'x-lse-tenant': ids.tenant };
  const created = await app.inject({
    method: 'POST',
    url: '/api/support-tickets',
    headers: proxied,
    payload: { kind: 'SUPPORT', title: `${P}代管时提交`, content: '代管时提交的详细描述' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  const row = await prisma.supportTicket.findUniqueOrThrow({ where: { id } });
  assert.equal(row.tenantId, PLATFORM_TENANT_ID, '按提交人的本属租户归属');

  for (const [view, headers] of [
    ['平台租户', bearer(adminToken)],
    ['代管租户', proxied],
  ] as const) {
    const mine = await app.inject({ url: '/api/support-tickets', headers });
    assert.equal(mine.statusCode, 200, `${view}: ${mine.body}`);
    const mineIds = mine.json().items.map((t: { id: string }) => t.id);
    assert.ok(mineIds.includes(id), `${view}的「我的工单」里有代管时提交的工单`);
    assert.ok(!mineIds.includes(others.id), `${view}的「我的工单」里没有别人的工单`);
  }

  const detail = await app.inject({ url: `/api/support-tickets/${id}`, headers: proxied });
  assert.equal(detail.statusCode, 200, detail.body);
  const added = await app.inject({
    method: 'POST',
    url: `/api/support-tickets/${id}/replies`,
    headers: proxied,
    payload: { content: '代管时追加' },
  });
  assert.equal(added.statusCode, 201, added.body);
  assert.equal(added.json().status, 'OPEN');
});

test('「全部租户」视角下「我的工单」只列自己提交的', async () => {
  const mineTicket = await submit(adminToken, 'FEEDBACK', '全部租户视角下自己的反馈');
  const othersTicket = await submit(tokens.a, 'FEEDBACK', '全部租户视角下别人的反馈');
  const tenantTicket = await submit(tokens.tenantAdmin, 'FEEDBACK', '全部租户视角下其他租户的反馈');
  const all = { ...bearer(adminToken), 'x-lse-tenant': 'all' };

  const mine = await app.inject({ url: '/api/support-tickets', headers: all });
  assert.equal(mine.statusCode, 200, mine.body);
  const mineIds = mine.json().items.map((t: { id: string }) => t.id);
  assert.ok(mineIds.includes(mineTicket.id));
  assert.ok(!mineIds.includes(othersTicket.id));
  assert.ok(!mineIds.includes(tenantTicket.id));

  const manage = await app.inject({ url: '/api/support-tickets/manage', headers: all });
  assert.equal(manage.statusCode, 200, manage.body);
  const manageIds = manage.json().items.map((t: { id: string }) => t.id);
  assert.ok(manageIds.includes(othersTicket.id) && manageIds.includes(tenantTicket.id));
});

/** 等到有会话卡在行锁上（回复请求已经读过工单、正在等写）。 */
async function waitForLockWaiter(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等不到回复请求卡在行锁上');
}

test('关闭与回复并发：关闭先落库时，回复返回 409，不会把状态改回去', async () => {
  const ticket = await submit(tokens.a, 'SUPPORT', '并发关闭');
  let pending: ReturnType<typeof reply> | undefined;
  // 锁住工单行模拟「关闭」正在提交：回复请求读到的还是 OPEN，写的时候被挡住，关闭落库后才继续。
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM support_tickets WHERE id = ${ticket.id} FOR UPDATE`;
      pending = reply(tokens.a, ticket.id, '并发追加');
      await waitForLockWaiter();
      await tx.supportTicket.update({ where: { id: ticket.id }, data: { status: 'CLOSED' } });
    },
    { timeout: 15_000 },
  );
  const res = await pending!;
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.json().error.message, /工单已关闭/);
  const row = await prisma.supportTicket.findUniqueOrThrow({
    where: { id: ticket.id },
    include: { replies: true },
  });
  assert.equal(row.status, 'CLOSED');
  assert.equal(row.replies.length, 0, '被拒的回复不落库');
});

test('工单的写操作都记审计', async () => {
  await prisma.auditLog.deleteMany({ where: { action: { startsWith: 'support_ticket.' } } });
  const ticket = await submit(tokens.a, 'FEEDBACK', '审计');
  assert.equal((await reply(adminToken, ticket.id, '谢谢反馈')).statusCode, 201);
  const closed = await app.inject({
    method: 'POST',
    url: `/api/support-tickets/${ticket.id}/close`,
    headers: bearer(adminToken),
  });
  assert.equal(closed.statusCode, 200, closed.body);

  const logs = await prisma.auditLog.findMany({
    where: { action: { startsWith: 'support_ticket.' } },
    orderBy: { createdAt: 'asc' },
  });
  assert.deepEqual(
    logs.map((l) => [l.action, l.actorName, l.targetType, l.targetId]),
    [
      ['support_ticket.create', `${P}a`, 'support_ticket', ticket.id],
      ['support_ticket.reply', 'admin', 'support_ticket', ticket.id],
      ['support_ticket.close', 'admin', 'support_ticket', ticket.id],
    ],
  );
});

test('未登录不能提交工单', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/support-tickets',
    payload: { kind: 'SUPPORT', title: P + '匿名', content: '匿名' },
  });
  assert.equal(res.statusCode, 401, res.body);
});

test('support:manage 是平台级权限，只给内置 admin', async () => {
  assert.ok(PERMISSION_CODES.includes('support:manage'));
  assert.ok(PLATFORM_ONLY_PERMISSIONS.includes('support:manage'));
  const byRole = new Map(ROLE_DEFS.map((r) => [r.name, r.permissions]));
  assert.ok(byRole.get('admin')!.includes('support:manage'));
  for (const role of ['tenant_admin', 'operator', 'auditor']) {
    assert.ok(!byRole.get(role)!.includes('support:manage'), role);
  }
  const admin = await prisma.role.findUniqueOrThrow({
    where: { name: 'admin' },
    include: { permissions: { include: { permission: true } } },
  });
  assert.ok(
    admin.permissions.some((p) => p.permission.code === 'support:manage'),
    '迁移已给 admin 角色',
  );
});
