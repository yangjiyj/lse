import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { prisma } from '../src/db.js';
import {
  bearer,
  createToolTestContext,
  destroyToolTestContext,
  seedTool,
  type ToolTestContext,
} from './helpers/tool-fixtures.js';

// 首页工具数（A-9，需求 2.2.1）：overview 的 counts.tools 是当前用户可见的工具数。

const P = 'zz-a9-';
const PASSWORD = ['Dash', 'Tool', '12345'].join('@');
let ctx: ToolTestContext;
let taskOnlyToken = '';

async function overviewTools(token: string): Promise<number | null> {
  const res = await ctx.app.inject({ url: '/api/dashboard/overview', headers: bearer(token) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().counts.tools;
}

before(async () => {
  ctx = await createToolTestContext(P);
  await seedTool(P, 'shown');
  await seedTool(P, 'disabled', { enabled: false });
  await seedTool(P, 'hidden', { hidden: true });
  // 只有 eval_task:read、没有 tool:read 的角色
  const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'eval_task:read' } });
  const role = await prisma.role.create({
    data: {
      name: `${P}task-only`,
      description: '只看任务',
      permissions: { create: { permissionId: perm.id } },
    },
  });
  await prisma.user.create({
    data: {
      username: `${P}taskonly`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: 'task only',
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: `${P}taskonly`, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  taskOnlyToken = login.json().token;
});

after(async () => {
  await destroyToolTestContext(ctx, P);
  await prisma.$disconnect();
});

test('隐藏工具不计入 operator 的 tools，禁用的照算；平台管理员算上隐藏的', async () => {
  const visible = await prisma.tool.count({ where: { hidden: false } });
  const all = await prisma.tool.count();
  assert.ok(all > visible, '夹具里要有隐藏工具');
  assert.equal(await overviewTools(ctx.tokens.operator), visible);
  assert.equal(await overviewTools(ctx.tokens.admin), all);
});

test('没有 tool:read 时 tools 为 null', async () => {
  assert.equal(await overviewTools(taskOnlyToken), null);
});
