import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prismaUnscoped } from '../src/db.js';
import { MAX_ORG_DEPTH } from '../src/modules/organizations/service.js';

// 2.9.1 用户绑定组织：建用户、改用户接受 organizationId（必须是本租户的组织），
// 用户列表按组织（可含下级）筛选并返回组织路径。

const TENANT_PREFIX = 'D3用户组织测试';
const USER_PREFIX = '__d3_uorg_';
const PASSWORD = ['Uorg', 'Test', '12345'].join('@');

let app: Awaited<ReturnType<typeof buildApp>>;
let tenantA = '';
let tenantB = '';
let adminA = '';
let adminB = '';
let hq = '';
let rd = '';
let sec = '';
let ops = '';
let foreignOrg = '';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

interface UserItem {
  id: string;
  username: string;
  organizationId: string | null;
  organizationPath: string | null;
  registrationStatus: string;
}

async function cleanup(): Promise<void> {
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: { startsWith: TENANT_PREFIX } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await prismaUnscoped.user.updateMany({
    where: { tenantId: { in: ids } },
    data: { organizationId: null },
  });
  for (let i = 0; i <= MAX_ORG_DEPTH + 1; i += 1) {
    const r = await prismaUnscoped.organization.deleteMany({
      where: { tenantId: { in: ids }, children: { none: {} } },
    });
    if (r.count === 0) break;
  }
  await prismaUnscoped.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: USER_PREFIX } } });
  await prismaUnscoped.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function createAdmin(tenantId: string, name: string): Promise<string> {
  const role = await prismaUnscoped.role.findUniqueOrThrow({ where: { name: 'tenant_admin' } });
  await prismaUnscoped.user.create({
    data: {
      tenantId,
      username: `${USER_PREFIX}${name}`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: name,
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: `${USER_PREFIX}${name}`, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function org(tenantId: string, name: string, parentId: string | null = null) {
  return (await prismaUnscoped.organization.create({ data: { tenantId, name, parentId } })).id;
}

async function createUser(token: string, name: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/users',
    headers: bearer(token),
    payload: {
      username: `${USER_PREFIX}${name}`,
      password: PASSWORD,
      displayName: name,
      ...extra,
    },
  });
}

async function listUsers(token: string, query: string): Promise<UserItem[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/users?pageSize=200&${query}`,
    headers: bearer(token),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().items as UserItem[];
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  tenantA = (
    await prismaUnscoped.tenant.create({ data: { name: `${TENANT_PREFIX}A`, code: 'd3-uorg-a' } })
  ).id;
  tenantB = (
    await prismaUnscoped.tenant.create({ data: { name: `${TENANT_PREFIX}B`, code: 'd3-uorg-b' } })
  ).id;
  adminA = await createAdmin(tenantA, 'admin_a');
  adminB = await createAdmin(tenantB, 'admin_b');
  hq = await org(tenantA, '总部');
  rd = await org(tenantA, '研发中心', hq);
  sec = await org(tenantA, '安全组', rd);
  ops = await org(tenantA, '运营中心', hq);
  foreignOrg = await org(tenantB, '乙租户总部');
});

after(async () => {
  await cleanup();
  await app.close();
});

test('建用户时绑定本租户的组织，返回组织路径', async () => {
  const res = await createUser(adminA, 'sec_member', { organizationId: sec });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as UserItem;
  assert.equal(body.organizationId, sec);
  assert.equal(body.organizationPath, '总部 / 研发中心 / 安全组');
  const row = await prismaUnscoped.user.findUniqueOrThrow({ where: { id: body.id } });
  assert.equal(row.organizationId, sec);

  const plain = await createUser(adminA, 'no_org');
  assert.equal(plain.statusCode, 201, plain.body);
  assert.equal(plain.json().organizationId, null);
  assert.equal(plain.json().organizationPath, null);
});

test('绑别的租户的组织：建用户、改用户都 400', async () => {
  const created = await createUser(adminA, 'foreign_bind', { organizationId: foreignOrg });
  assert.equal(created.statusCode, 400, created.body);
  assert.equal(
    await prismaUnscoped.user.count({ where: { username: `${USER_PREFIX}foreign_bind` } }),
    0,
  );

  const mine = await createUser(adminA, 'patch_foreign');
  assert.equal(mine.statusCode, 201, mine.body);
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/users/${mine.json().id}`,
    headers: bearer(adminA),
    payload: { organizationId: foreignOrg },
  });
  assert.equal(patched.statusCode, 400, patched.body);
  const row = await prismaUnscoped.user.findUniqueOrThrow({ where: { id: mine.json().id } });
  assert.equal(row.organizationId, null);

  // 乙租户管理员也不能把自己的用户绑到甲租户的组织
  const inB = await createUser(adminB, 'b_user', { organizationId: hq });
  assert.equal(inB.statusCode, 400, inB.body);
});

test('改用户：换组织、清空组织', async () => {
  const created = await createUser(adminA, 'mover', { organizationId: rd });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: bearer(adminA), payload });

  const moved = await patch({ organizationId: ops });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().organizationPath, '总部 / 运营中心');
  // 不带 organizationId 不动它
  const renamed = await patch({ displayName: '改了名' });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().organizationId, ops);
  const cleared = await patch({ organizationId: null });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().organizationId, null);
  assert.equal(cleared.json().organizationPath, null);
});

test('用户列表按组织筛选：只看本节点，或含下级', async () => {
  const inSec = await createUser(adminA, 'list_sec', { organizationId: sec });
  const inHq = await createUser(adminA, 'list_hq', { organizationId: hq });
  const inOps = await createUser(adminA, 'list_ops', { organizationId: ops });
  for (const r of [inSec, inHq, inOps]) assert.equal(r.statusCode, 201, r.body);

  const direct = await listUsers(adminA, `organizationId=${hq}`);
  assert.deepEqual(
    direct.map((u) => u.username),
    [`${USER_PREFIX}list_hq`],
  );
  const deep = await listUsers(adminA, `organizationId=${rd}&includeDescendants=true`);
  const deepNames = deep.map((u) => u.username);
  assert.ok(deepNames.includes(`${USER_PREFIX}list_sec`), '含下级时应查到安全组的成员');
  assert.ok(!deepNames.includes(`${USER_PREFIX}list_ops`));
  assert.ok(!deepNames.includes(`${USER_PREFIX}list_hq`));
  const hit = deep.find((u) => u.username === `${USER_PREFIX}list_sec`)!;
  assert.equal(hit.organizationPath, '总部 / 研发中心 / 安全组');

  const all = await listUsers(adminA, `organizationId=${hq}&includeDescendants=true`);
  for (const name of ['list_sec', 'list_hq', 'list_ops']) {
    assert.ok(
      all.some((u) => u.username === `${USER_PREFIX}${name}`),
      name,
    );
  }

  // 列表本身也带组织路径；注册审核相关字段照旧返回
  const everyone = await listUsers(adminA, '');
  const opsUser = everyone.find((u) => u.username === `${USER_PREFIX}list_ops`)!;
  assert.equal(opsUser.organizationPath, '总部 / 运营中心');
  assert.equal(opsUser.registrationStatus, 'NONE');

  // 用别的租户的组织筛：什么都查不到
  const foreign = await listUsers(adminB, `organizationId=${hq}&includeDescendants=true`);
  assert.equal(foreign.length, 0);
});

async function lastAudit(action: string, targetId: string) {
  return prismaUnscoped.auditLog.findFirst({
    where: { action, targetId },
    orderBy: { createdAt: 'desc' },
  });
}

test('改用户换了组织：user.update 审计记下改前改后的组织 id 和路径', async () => {
  const created = await createUser(adminA, 'audit_mover', { organizationId: rd });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: bearer(adminA), payload });

  assert.equal((await patch({ organizationId: ops })).statusCode, 200);
  assert.deepEqual((await lastAudit('user.update', id))?.detail, {
    before: { organizationId: rd, organizationPath: '总部 / 研发中心' },
    after: { organizationId: ops, organizationPath: '总部 / 运营中心' },
  });

  assert.equal((await patch({ organizationId: null })).statusCode, 200);
  assert.deepEqual((await lastAudit('user.update', id))?.detail, {
    before: { organizationId: ops, organizationPath: '总部 / 运营中心' },
    after: { organizationId: null, organizationPath: null },
  });

  // 组织没变（没带或带了同一个）：不记组织
  for (const payload of [{ displayName: '只改姓名' }, { organizationId: null }]) {
    assert.equal((await patch(payload)).statusCode, 200);
    const audit = await lastAudit('user.update', id);
    assert.ok(audit);
    assert.equal(audit.detail, null, JSON.stringify(audit.detail));
  }
});

/**
 * 组织在接口校验之后、写库之前被删：另开事务删掉组织先不提交，等请求的写库卡在外键检查上再提交。
 */
async function deleteOrgWhile<T>(orgId: string, send: () => Promise<T>): Promise<T> {
  let pending: Promise<T> | undefined;
  await prismaUnscoped.$transaction(
    async (tx) => {
      await tx.organization.delete({ where: { id: orgId } });
      pending = send();
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i += 1) {
        const [row] = await prismaUnscoped.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        blocked = Boolean(row && row.n > 0);
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // 没卡住说明请求没走到写库（比如校验就拦下了），这条用例就没测到外键那一步。
      assert.ok(blocked, '请求的写库没有卡在外键检查上');
    },
    { timeout: 20_000 },
  );
  return pending!;
}

test('校验之后组织被删：建用户、改用户都返回 400「组织不存在」，不是 500', async () => {
  const doomed = await org(tenantA, '马上删掉的组织', hq);
  const created = await deleteOrgWhile(doomed, () =>
    createUser(adminA, 'race_create', { organizationId: doomed }),
  );
  assert.equal(created.statusCode, 400, created.body);
  assert.equal(created.json().error.message, '组织不存在');
  assert.equal(
    await prismaUnscoped.user.count({ where: { username: `${USER_PREFIX}race_create` } }),
    0,
  );

  const mine = await createUser(adminA, 'race_update');
  assert.equal(mine.statusCode, 201, mine.body);
  const doomed2 = await org(tenantA, '马上删掉的组织二', hq);
  const patched = await deleteOrgWhile(doomed2, () =>
    app.inject({
      method: 'PATCH',
      url: `/api/users/${mine.json().id}`,
      headers: bearer(adminA),
      payload: { organizationId: doomed2 },
    }),
  );
  assert.equal(patched.statusCode, 400, patched.body);
  assert.equal(patched.json().error.message, '组织不存在');
  const row = await prismaUnscoped.user.findUniqueOrThrow({ where: { id: mine.json().id } });
  assert.equal(row.organizationId, null);
});
