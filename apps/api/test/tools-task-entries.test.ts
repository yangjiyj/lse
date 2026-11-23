import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_PROBE_TOOL_CODE,
  DETECT_CATEGORIES,
  PERMISSION_CODES,
  TOOL_TASK_ENTRIES,
  canCreateToolTask,
  toolTaskEntry,
} from '@lse/shared';
import { prisma } from '../src/db.js';
import {
  bearer,
  createToolTestContext,
  destroyToolTestContext,
  type ToolTestContext,
} from './helpers/tool-fixtures.js';

// 快速建任务和任务列表（A-7，需求 2.3.6、2.3.10）：任务入口只能取白名单里的 key，详情按白名单给出路径。

const P = 'zz-a7-';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let ctx: ToolTestContext;
let toolId = '';

function patchTool(token: string, id: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/tools/${id}`,
    headers: bearer(token),
    payload,
  });
}

before(async () => {
  ctx = await createToolTestContext(P);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/tools',
    headers: bearer(ctx.tokens.admin),
    payload: {
      code: `${P}entry`,
      name: '入口工具',
      category: 'model',
      taskEntry: 'model-file-scan',
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  toolId = res.json().id;
});

after(async () => {
  await destroyToolTestContext(ctx, P);
  await prisma.$disconnect();
});

test('白名单登记了现有九类检测，路径都是站内路由', () => {
  // 其他线会往白名单里加入口（如语料扫描），这里只核对本线登记的九类都在。
  for (const key of [
    'ai-component-scan',
    'asset-discovery',
    'content-eval',
    'fleet-eval',
    'fleet-onboard',
    'model-file-scan',
    'red-team',
    'service-assurance',
    'standard-eval',
  ])
    assert.ok(key in TOOL_TASK_ENTRIES, `白名单缺 ${key}`);
  const app = readFileSync(path.join(ROOT, 'apps/web/src/App.tsx'), 'utf8');
  const routes = new Set([...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]!));
  for (const [key, entry] of Object.entries(TOOL_TASK_ENTRIES)) {
    assert.equal(entry.key, key);
    assert.ok((DETECT_CATEGORIES as readonly string[]).includes(entry.category), key);
    for (const p of [entry.createPath, entry.listPath]) {
      assert.match(p, /^\/[a-z0-9/-]*(\?[a-z]+=[a-z0-9-]+)?$/, `${key}: ${p}`);
      assert.ok(routes.has(p.split('?')[0]!), `${key} 的 ${p} 不是 App.tsx 里的路由`);
    }
  }
  assert.equal(toolTaskEntry('nope'), null);
  assert.equal(toolTaskEntry('constructor'), null, '原型链上的属性不算');
});

test('每个入口登记了目标页建任务所需的权限码', () => {
  for (const [key, entry] of Object.entries(TOOL_TASK_ENTRIES)) {
    const codes = typeof entry.permission === 'string' ? [entry.permission] : entry.permission;
    assert.ok(codes.length > 0, key);
    for (const code of codes) assert.ok(PERMISSION_CODES.includes(code), `${key}: ${code}`);
  }
  assert.equal(TOOL_TASK_ENTRIES['model-file-scan'].permission, 'engine:scan');
  assert.equal(TOOL_TASK_ENTRIES['content-eval'].permission, 'eval_task:create');
  assert.equal(TOOL_TASK_ENTRIES['service-assurance'].permission, 'service_assurance:scan');
  assert.equal(TOOL_TASK_ENTRIES['fleet-onboard'].permission, 'model_target:create');
  const fleetEval = TOOL_TASK_ENTRIES['fleet-eval'];
  assert.equal(
    canCreateToolTask(fleetEval, (c) => c === 'model_target:create'),
    false,
    '两个都要有',
  );
  assert.equal(
    canCreateToolTask(fleetEval, (c) => c === 'model_target:create' || c === 'eval_task:create'),
    true,
  );
});

test('建工具时登记的任务入口在详情里给出新建和列表路径', async () => {
  const res = await ctx.app.inject({
    url: `/api/tools/${toolId}`,
    headers: bearer(ctx.tokens.operator),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().taskEntry, 'model-file-scan');
  assert.deepEqual(res.json().task, TOOL_TASK_ENTRIES['model-file-scan']);
});

test('taskEntry 不在白名单 400，可以改成别的入口或清空', async () => {
  for (const bad of ['evil', 'https://evil.example/x', '/eval-tasks', '']) {
    const res = await patchTool(ctx.tokens.admin, toolId, { taskEntry: bad });
    assert.equal(res.statusCode, 400, bad);
  }
  const create = await ctx.app.inject({
    method: 'POST',
    url: '/api/tools',
    headers: bearer(ctx.tokens.admin),
    payload: {
      code: `${P}bad`,
      name: '坏入口',
      category: 'model',
      taskEntry: 'javascript:alert(1)',
    },
  });
  assert.equal(create.statusCode, 400);

  const changed = await patchTool(ctx.tokens.admin, toolId, { taskEntry: 'red-team' });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().task.createPath, '/eval-tasks?launch=redteam');
  const cleared = await patchTool(ctx.tokens.admin, toolId, { taskEntry: null });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().taskEntry, null);
  assert.equal(cleared.json().task, null);
});

test('内置探针返回终端接入的路径，任务入口不能改', async () => {
  const probe = await prisma.tool.findUniqueOrThrow({ where: { code: BUILTIN_PROBE_TOOL_CODE } });
  const res = await ctx.app.inject({
    url: `/api/tools/${probe.id}`,
    headers: bearer(ctx.tokens.operator),
  });
  assert.equal(res.statusCode, 200, res.body);
  const task = res.json().task;
  assert.equal(task.key, 'fleet-onboard');
  assert.equal(task.createPath, TOOL_TASK_ENTRIES['fleet-onboard'].createPath);
  assert.equal(task.listPath, TOOL_TASK_ENTRIES['fleet-onboard'].listPath);
  const list = await ctx.app.inject({ url: '/api/tools', headers: bearer(ctx.tokens.operator) });
  const item = (list.json().items as Array<{ id: string; task: { key: string } | null }>).find(
    (t) => t.id === probe.id,
  );
  assert.equal(item?.task?.key, 'fleet-onboard', '列表项也带任务入口');
  assert.equal(
    (await patchTool(ctx.tokens.admin, probe.id, { taskEntry: 'red-team' })).statusCode,
    400,
  );
});
