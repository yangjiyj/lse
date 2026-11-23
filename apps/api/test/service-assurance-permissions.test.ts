import assert from 'node:assert/strict';
import test from 'node:test';
import { PERMISSION_CODES, ROLE_DEFS } from '@lse/shared';
import type { CurrentUser } from '../src/lib/rbac.js';

const SERVICE_PERMISSIONS = [
  'service_assurance:read',
  'service_assurance:scan',
  'service_assurance:verify',
  'service_assurance:review',
] as const;

function rolePermissions(name: string): Set<string> {
  const role = ROLE_DEFS.find((item) => item.name === name);
  assert.ok(role, `missing role ${name}`);
  return new Set(role.permissions);
}

function user(input: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'user-a',
    username: 'user-a',
    displayName: '用户甲',
    email: null,
    isBuiltin: false,
    isActive: true,
    roles: ['operator'],
    permissions: new Set(SERVICE_PERMISSIONS),
    preferences: null,
    ...input,
  };
}

function fakeDb(createdById: string | null) {
  return {
    evalTask: {
      findUnique: async () => ({ id: 'task-a', createdById }),
    },
  };
}

test('服务核验权限目录与内置角色遵循最小权限', () => {
  for (const code of SERVICE_PERMISSIONS) assert.ok(PERMISSION_CODES.includes(code));

  const admin = rolePermissions('admin');
  const operator = rolePermissions('operator');
  const auditor = rolePermissions('auditor');
  for (const code of SERVICE_PERMISSIONS) assert.equal(admin.has(code), true);
  assert.deepEqual(
    SERVICE_PERMISSIONS.filter((code) => operator.has(code)),
    ['service_assurance:read', 'service_assurance:scan', 'service_assurance:verify'],
  );
  assert.deepEqual(
    SERVICE_PERMISSIONS.filter((code) => auditor.has(code)),
    ['service_assurance:read'],
  );
});

test('任务对象访问允许本人任务和内置管理员', async () => {
  const { assertTaskAccess } = await import('../src/modules/service-assurance/task-access.js');

  await assert.doesNotReject(() => assertTaskAccess(user(), 'task-a', 'scan', fakeDb('user-a')));
  await assert.doesNotReject(() =>
    assertTaskAccess(user({ isBuiltin: true, id: 'admin' }), 'task-a', 'review', fakeDb('user-b')),
  );
});

test('任务对象访问拒绝他人任务并隐藏读取存在性', async () => {
  const { assertTaskAccess } = await import('../src/modules/service-assurance/task-access.js');

  await assert.rejects(
    () => assertTaskAccess(user(), 'task-b', 'read', fakeDb('user-b')),
    (error: unknown) =>
      (error as { statusCode?: number; code?: string }).statusCode === 404 &&
      (error as { code?: string }).code === 'EVAL_TASK_NOT_FOUND',
  );
  await assert.rejects(
    () => assertTaskAccess(user(), 'task-b', 'scan', fakeDb('user-b')),
    (error: unknown) =>
      (error as { statusCode?: number; code?: string }).statusCode === 403 &&
      (error as { code?: string }).code === 'EVAL_TASK_ACCESS_DENIED',
  );
});

test('历史无创建人任务只允许普通用户读取', async () => {
  const { assertTaskAccess } = await import('../src/modules/service-assurance/task-access.js');

  await assert.doesNotReject(() => assertTaskAccess(user(), 'legacy-task', 'read', fakeDb(null)));
  await assert.rejects(
    () => assertTaskAccess(user(), 'legacy-task', 'scan', fakeDb(null)),
    (error: unknown) =>
      (error as { statusCode?: number; code?: string }).statusCode === 403 &&
      (error as { code?: string }).code === 'EVAL_TASK_ACCESS_DENIED',
  );
});

test('操作权限在查询任务对象前拒绝，避免利用对象标识探测', async () => {
  const { assertTaskAccess } = await import('../src/modules/service-assurance/task-access.js');
  let queried = false;
  const db = {
    evalTask: {
      findUnique: async () => {
        queried = true;
        return { id: 'task-a', createdById: 'user-a' };
      },
    },
  };

  await assert.rejects(
    () =>
      assertTaskAccess(
        user({ permissions: new Set(['service_assurance:read']) }),
        'task-a',
        'verify',
        db,
      ),
    (error: unknown) =>
      (error as { statusCode?: number; code?: string }).statusCode === 403 &&
      (error as { code?: string }).code === 'SERVICE_ASSURANCE_PERMISSION_DENIED',
  );
  assert.equal(queried, false);
});

test('报告写操作要求服务核验读取权限且对他人任务返回 403', async () => {
  const { assertTaskAccess } = await import('../src/modules/service-assurance/task-access.js');
  const reportUser = user({ permissions: new Set(['service_assurance:read']) });

  await assert.doesNotReject(() =>
    assertTaskAccess(reportUser, 'task-a', 'report' as never, fakeDb('user-a')),
  );
  await assert.rejects(
    () => assertTaskAccess(reportUser, 'task-b', 'report' as never, fakeDb('user-b')),
    (error: unknown) =>
      (error as { statusCode?: number; code?: string }).statusCode === 403 &&
      (error as { code?: string }).code === 'EVAL_TASK_ACCESS_DENIED',
  );
});
