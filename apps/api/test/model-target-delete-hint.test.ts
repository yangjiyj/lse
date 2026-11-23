import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

/**
 * 模型被引用时只说一句"已被任务或结果引用"，用户看不出被什么挡住、
 * 也不知道下一步该干什么。提示要报出引用数量并指明先删任务。
 */
test('模型被任务引用时的删除提示要报出引用数量并指明出路', async () => {
  const app = await buildApp();
  const suffix = randomUUID().slice(0, 8);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  const token = login.json().token as string;

  const target = await prisma.modelTarget.create({
    data: {
      name: `in-use-${suffix}`,
      provider: 'openai-compatible',
      targetType: 'MODEL',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-key',
      model: 'test-model',
      isActive: true,
    },
  });
  const task = await prisma.evalTask.create({
    data: {
      name: `占用任务-${suffix}`,
      modelTargetId: target.id,
      engines: [],
      dimensions: [],
      status: 'COMPLETED',
    },
  });

  const blocked = await app.inject({
    method: 'DELETE',
    url: `/api/model-targets/${target.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(blocked.statusCode, 400, blocked.body);
  const error = blocked.json().error as { message: string; code?: string };
  assert.equal(error.code, 'MODEL_TARGET_IN_USE');
  assert.match(error.message, /1 个评估任务/);
  assert.match(error.message, /先删除这些评估任务/);

  // 按提示删掉任务之后，模型确实能删了。
  const removedTask = await app.inject({
    method: 'DELETE',
    url: `/api/eval-tasks/${task.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(removedTask.statusCode, 200, removedTask.body);

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/model-targets/${target.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(removed.statusCode, 200, removed.body);
});
