import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prismaUnscoped } from '../src/db.js';
import { MAX_ORG_DEPTH } from '../src/modules/organizations/service.js';

// 2.9.3 组织架构接口：树、增改删、成员，租户隔离、权限与审计。

const TENANT_PREFIX = 'D2组织接口测试';
const USER_PREFIX = '__d2_org_';
const PASSWORD = ['Org', 'Test', '12345'].join('@');

let app: Awaited<ReturnType<typeof buildApp>>;
let tenantA = '';
let tenantB = '';
let platformToken = '';
let adminA = '';
let adminB = '';
let operatorA = '';
let auditorA = '';
let memberA = '';

const bearer = (token: string, tenant?: string) => ({
  authorization: `Bearer ${token}`,
  ...(tenant ? { 'x-lse-tenant': tenant } : {}),
});

interface OrgNode {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
  memberCount: number;
  children: OrgNode[];
}

async function deleteTenantOrgs(tenantIds: string[]): Promise<void> {
  await prismaUnscoped.user.updateMany({
    where: { tenantId: { in: tenantIds } },
    data: { organizationId: null },
  });
  for (let i = 0; i <= MAX_ORG_DEPTH + 1; i += 1) {
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
  await prismaUnscoped.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: USER_PREFIX } } });
  await prismaUnscoped.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      username,
      password: username === 'admin' ? ['Admin', '@', '12345'].join('') : PASSWORD,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function createUser(tenantId: string, name: string, roleName: string): Promise<string> {
  const role = await prismaUnscoped.role.findUniqueOrThrow({ where: { name: roleName } });
  const user = await prismaUnscoped.user.create({
    data: {
      tenantId,
      username: `${USER_PREFIX}${name}`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: name,
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  return user.id;
}

async function create(token: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/organizations', headers: bearer(token), payload });
}

async function mustCreate(token: string, payload: Record<string, unknown>): Promise<OrgNode> {
  const res = await create(token, payload);
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as OrgNode;
}

async function tree(token: string, tenant?: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/organizations',
    headers: bearer(token, tenant),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

function find(nodes: OrgNode[], id: string): OrgNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = find(node.children, id);
    if (hit) return hit;
  }
  return undefined;
}

async function lastAudit(action: string, targetId: string) {
  return prismaUnscoped.auditLog.findFirst({
    where: { action, targetId },
    orderBy: { createdAt: 'desc' },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  tenantA = (
    await prismaUnscoped.tenant.create({ data: { name: `${TENANT_PREFIX}A`, code: 'd2-org-a' } })
  ).id;
  tenantB = (
    await prismaUnscoped.tenant.create({ data: { name: `${TENANT_PREFIX}B`, code: 'd2-org-b' } })
  ).id;
  await createUser(tenantA, 'admin_a', 'tenant_admin');
  await createUser(tenantB, 'admin_b', 'tenant_admin');
  await createUser(tenantA, 'operator_a', 'operator');
  await createUser(tenantA, 'auditor_a', 'auditor');
  memberA = await createUser(tenantA, 'member_a', 'operator');
  platformToken = await login('admin');
  adminA = await login(`${USER_PREFIX}admin_a`);
  adminB = await login(`${USER_PREFIX}admin_b`);
  operatorA = await login(`${USER_PREFIX}operator_a`);
  auditorA = await login(`${USER_PREFIX}auditor_a`);
});

after(async () => {
  await cleanup();
  await app.close();
});

test('新建组织写审计；返回本租户的树，按排序号排列，节点带成员数', async () => {
  const root = await mustCreate(adminA, { name: '树总部' });
  const audit = await lastAudit('organization.create', root.id);
  assert.ok(audit, '缺少 organization.create 审计');
  assert.equal(audit.tenantId, tenantA);
  assert.equal(audit.targetType, 'organization');

  const later = await mustCreate(adminA, { name: '乙中心', parentId: root.id, sort: 2 });
  const first = await mustCreate(adminA, { name: '甲中心', parentId: root.id, sort: 1 });
  const leaf = await mustCreate(adminA, { name: '安全组', parentId: first.id });
  await prismaUnscoped.user.update({ where: { id: memberA }, data: { organizationId: leaf.id } });

  const body = await tree(adminA);
  const node = find(body.items, root.id);
  assert.ok(node, '树里没有新建的根节点');
  assert.equal(node.parentId, null);
  assert.deepEqual(
    node.children.map((c) => c.name),
    ['甲中心', '乙中心'],
  );
  assert.equal(find(body.items, later.id)?.memberCount, 0);
  assert.equal(find(body.items, leaf.id)?.memberCount, 1);
  assert.equal(find(body.items, leaf.id)?.parentId, first.id);

  // 同一上级下重名
  const dup = await create(adminA, { name: '甲中心', parentId: root.id });
  assert.equal(dup.statusCode, 409, dup.body);

  await prismaUnscoped.user.update({ where: { id: memberA }, data: { organizationId: null } });
});

test('改名、排序、改上级；移到自己或子孙下 400，超过层级 400；写审计', async () => {
  const root = await mustCreate(adminA, { name: '移动总部' });
  const a = await mustCreate(adminA, { name: '甲', parentId: root.id });
  const a1 = await mustCreate(adminA, { name: '甲一', parentId: a.id });
  const b = await mustCreate(adminA, { name: '乙', parentId: root.id });

  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/organizations/${id}`,
      headers: bearer(adminA),
      payload,
    });

  const renamed = await patch(a.id, { name: '甲部', sort: 5 });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().name, '甲部');
  assert.equal(renamed.json().sort, 5);
  const audit = await lastAudit('organization.update', a.id);
  assert.ok(audit, '缺少 organization.update 审计');
  assert.equal(audit.tenantId, tenantA);

  const self = await patch(a.id, { parentId: a.id });
  assert.equal(self.statusCode, 400, self.body);
  assert.equal(self.json().error.code, 'ORG_CYCLE');
  const intoChild = await patch(a.id, { parentId: a1.id });
  assert.equal(intoChild.statusCode, 400, intoChild.body);
  assert.equal(intoChild.json().error.code, 'ORG_CYCLE');

  // 改到同级下：乙 → 甲部下
  const moved = await patch(b.id, { parentId: a.id });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().parentId, a.id);
  // 移到根
  const toRoot = await patch(b.id, { parentId: null });
  assert.equal(toRoot.statusCode, 200, toRoot.body);
  assert.equal(toRoot.json().parentId, null);

  // 移到新上级下重名
  await mustCreate(adminA, { name: '重名丙', parentId: root.id });
  const c = await mustCreate(adminA, { name: '重名丙', parentId: a.id });
  const clash = await patch(c.id, { parentId: root.id });
  assert.equal(clash.statusCode, 409, clash.body);

  // 层级：一条 7 级的链（深链1…深链7），把带一个下级的「甲部」（两级）挂到第 7 级下会到第 9 级
  let parentId: string | null = null;
  for (let level = 1; level <= MAX_ORG_DEPTH - 1; level += 1) {
    const node: OrgNode = await mustCreate(adminA, { name: `深链${level}`, parentId });
    parentId = node.id;
  }
  const tooDeep = await patch(a.id, { parentId });
  assert.equal(tooDeep.statusCode, 400, tooDeep.body);
  assert.equal(tooDeep.json().error.code, 'ORG_TOO_DEEP');
  // 只挂没有下级的「甲一」：到第 8 级，可以
  const ok = await patch(a1.id, { parentId });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('删除：有成员或下级 409，空节点可删并写审计', async () => {
  const root = await mustCreate(adminA, { name: '删除总部' });
  const child = await mustCreate(adminA, { name: '有人的部门', parentId: root.id });
  await prismaUnscoped.user.update({ where: { id: memberA }, data: { organizationId: child.id } });

  const del = (id: string) =>
    app.inject({ method: 'DELETE', url: `/api/organizations/${id}`, headers: bearer(adminA) });

  const withMember = await del(child.id);
  assert.equal(withMember.statusCode, 409, withMember.body);
  assert.equal(withMember.json().error.message, '请先移走下级组织和成员');
  const withChild = await del(root.id);
  assert.equal(withChild.statusCode, 409, withChild.body);
  assert.equal(withChild.json().error.message, '请先移走下级组织和成员');

  await prismaUnscoped.user.update({ where: { id: memberA }, data: { organizationId: null } });
  const okChild = await del(child.id);
  assert.equal(okChild.statusCode, 200, okChild.body);
  const okRoot = await del(root.id);
  assert.equal(okRoot.statusCode, 200, okRoot.body);
  assert.equal(await prismaUnscoped.organization.count({ where: { id: root.id } }), 0);
  const audit = await lastAudit('organization.delete', root.id);
  assert.ok(audit, '缺少 organization.delete 审计');
  assert.equal(audit.tenantId, tenantA);
});

test('成员：只看本节点，或含下级', async () => {
  const root = await mustCreate(adminA, { name: '成员总部' });
  const child = await mustCreate(adminA, { name: '成员部门', parentId: root.id });
  const leaf = await mustCreate(adminA, { name: '成员小组', parentId: child.id });
  await prismaUnscoped.user.update({ where: { id: memberA }, data: { organizationId: leaf.id } });

  const members = async (id: string, query = '') => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/organizations/${id}/members${query}`,
      headers: bearer(auditorA),
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as {
      items: { id: string; organizationId: string; organizationPath: string }[];
      total: number;
    };
  };

  const direct = await members(root.id);
  assert.equal(direct.total, 0);
  const deep = await members(root.id, '?includeDescendants=true');
  assert.equal(deep.total, 1);
  assert.equal(deep.items[0]!.id, memberA);
  assert.equal(deep.items[0]!.organizationPath, '成员总部 / 成员部门 / 成员小组');
  const notDeep = await members(root.id, '?includeDescendants=false');
  assert.equal(notDeep.total, 0);
  const own = await members(leaf.id);
  assert.equal(own.total, 1);

  await prismaUnscoped.user.update({ where: { id: memberA }, data: { organizationId: null } });
});

test('另一个租户的组织：看不到，读成员、改、删都 404', async () => {
  const theirs = await mustCreate(adminA, { name: '甲租户的组织' });
  const body = await tree(adminB);
  assert.equal(find(body.items, theirs.id), undefined);

  const members = await app.inject({
    method: 'GET',
    url: `/api/organizations/${theirs.id}/members`,
    headers: bearer(adminB),
  });
  assert.equal(members.statusCode, 404, members.body);
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/organizations/${theirs.id}`,
    headers: bearer(adminB),
    payload: { name: '改别人的' },
  });
  assert.equal(patch.statusCode, 404, patch.body);
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/organizations/${theirs.id}`,
    headers: bearer(adminB),
  });
  assert.equal(del.statusCode, 404, del.body);
  // 挂到别人的组织下
  const under = await create(adminB, { name: '挂到甲租户下', parentId: theirs.id });
  assert.equal(under.statusCode, 400, under.body);
  // 把自己的组织移到别人的组织下
  const mine = await mustCreate(adminB, { name: '乙租户的组织' });
  const move = await app.inject({
    method: 'PATCH',
    url: `/api/organizations/${mine.id}`,
    headers: bearer(adminB),
    payload: { parentId: theirs.id },
  });
  assert.equal(move.statusCode, 400, move.body);
  assert.equal(
    (await prismaUnscoped.organization.findUniqueOrThrow({ where: { id: theirs.id } })).name,
    '甲租户的组织',
  );
});

test('operator 能看树，写操作 403', async () => {
  const org = await mustCreate(adminA, { name: '权限测试组织' });
  await tree(operatorA);
  await tree(auditorA);
  const post = await create(operatorA, { name: '操作员新建' });
  assert.equal(post.statusCode, 403, post.body);
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/organizations/${org.id}`,
    headers: bearer(operatorA),
    payload: { name: '操作员改名' },
  });
  assert.equal(patch.statusCode, 403, patch.body);
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/organizations/${org.id}`,
    headers: bearer(operatorA),
  });
  assert.equal(del.statusCode, 403, del.body);
});

test('全部租户视角：读按租户分组返回，写要求选具体租户', async () => {
  const inA = await mustCreate(adminA, { name: '分组甲' });
  const inB = await mustCreate(adminB, { name: '分组乙' });
  const body = (await tree(platformToken, 'all')) as {
    groups: { tenantId: string; tenantName: string; items: OrgNode[] }[];
  };
  const groupA = body.groups.find((g) => g.tenantId === tenantA);
  const groupB = body.groups.find((g) => g.tenantId === tenantB);
  assert.equal(groupA?.tenantName, `${TENANT_PREFIX}A`);
  assert.ok(find(groupA!.items, inA.id));
  assert.equal(find(groupA!.items, inB.id), undefined);
  assert.ok(find(groupB!.items, inB.id));

  const filtered = (await (
    await app.inject({
      method: 'GET',
      url: `/api/organizations?tenantId=${tenantB}`,
      headers: bearer(platformToken, 'all'),
    })
  ).json()) as { groups: { tenantId: string }[] };
  assert.deepEqual(
    filtered.groups.map((g) => g.tenantId),
    [tenantB],
  );

  const write = await app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: bearer(platformToken, 'all'),
    payload: { name: '全部视角新建' },
  });
  assert.equal(write.statusCode, 409, write.body);
  assert.equal(write.json().error.code, 'TENANT_REQUIRED');

  // 进入具体租户代管：写到该租户
  const managed = await app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: bearer(platformToken, tenantB),
    payload: { name: '平台代管新建' },
  });
  assert.equal(managed.statusCode, 201, managed.body);
  const row = await prismaUnscoped.organization.findUniqueOrThrow({
    where: { id: managed.json().id },
  });
  assert.equal(row.tenantId, tenantB);
});

test('成员接口不返回邮箱：operator 只拿到用户名、姓名、状态和组织', async () => {
  const org = await mustCreate(adminA, { name: '邮箱测试组织' });
  await prismaUnscoped.user.update({
    where: { id: memberA },
    data: { organizationId: org.id, email: 'member-a@example.com' },
  });
  const res = await app.inject({
    method: 'GET',
    url: `/api/organizations/${org.id}/members`,
    headers: bearer(operatorA),
  });
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json().items as Record<string, unknown>[];
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, memberA);
  assert.ok(!('email' in items[0]!), `成员接口不应返回邮箱：${res.body}`);
  assert.ok(!res.body.includes('member-a@example.com'));
  await prismaUnscoped.user.update({
    where: { id: memberA },
    data: { organizationId: null, email: null },
  });
});

test('接口改名撞同级 409：大小写、首尾空白、零宽字符不同也算重名', async () => {
  const root = await mustCreate(adminA, { name: '改名接口总部' });
  await mustCreate(adminA, { name: 'Dev', parentId: root.id });
  const ops = await mustCreate(adminA, { name: 'Ops', parentId: root.id });
  for (const name of ['Dev', 'dev', ' DEV ', 'Dev​']) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/organizations/${ops.id}`,
      headers: bearer(adminA),
      payload: { name },
    });
    assert.equal(res.statusCode, 409, `${JSON.stringify(name)}：${res.body}`);
    assert.equal(res.json().error.code, 'ORG_NAME_TAKEN');
  }
  // 新建：全角空格首尾去掉后入库
  const created = await mustCreate(adminA, { name: '　测试组　', parentId: root.id });
  assert.equal(created.name, '测试组');
  // 只有不可见字符：400
  const blank = await create(adminA, { name: '​　', parentId: root.id });
  assert.equal(blank.statusCode, 400, blank.body);
});
