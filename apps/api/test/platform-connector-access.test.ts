import { PERMISSION_CODES, ROLE_DEFS } from '@lse/shared/permissions';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  CONNECTOR_RESTRICTED, connectorOwnerWhere, enforcePlatformConnectorAccess,
  type ConnectorAccessStore,
} from '../src/lib/platform-connector-access.js';
import type { CurrentUser } from '../src/lib/rbac.js';

const user = (restricted = true, builtin = false) => ({
  id: 'service', isBuiltin: builtin,
  permissions: new Set(restricted ? [CONNECTOR_RESTRICTED, 'report:generate'] : ['report:generate']),
}) as CurrentUser;
const record = (id: string) => id === 'own' ? { createdById: 'service' }
  : id === 'foreign' ? { createdById: 'other' }
  : id === 'legacy' ? { createdById: null } : null;
const store: ConnectorAccessStore = {
  evalTask: { findUnique: async ({ where }) => record(where.id) },
  modelTarget: { findUnique: async ({ where }) => record(where.id) },
  report: { findUnique: async ({ where }) => ({ task: record(where.id) }) },
  finding: { findUnique: async ({ where }) => ({ task: record(where.id) }) },
};
const check = (method: string, route: string, params?: unknown, body?: unknown, actor = user()) =>
  enforcePlatformConnectorAccess(actor, { method, routeOptions: { url: route }, params, body }, store);
test('连接器可读取版本能力和本账号任务结论，其他归属一律返回 404', async () => {
  await check('GET', '/api/version');
  await check('GET', '/api/eval-tasks/:id/verdict', { id: 'own' });
  for (const id of ['foreign', 'legacy', 'missing']) {
    await assert.rejects(check('GET', '/api/eval-tasks/:id/verdict', { id }), {
      statusCode: 404,
      code: 'CONNECTOR_RESOURCE_NOT_FOUND',
    });
  }
  await assert.rejects(check('POST', '/api/eval-tasks/:id/verdict', { id: 'own' }), {
    code: 'CONNECTOR_OPERATION_DENIED',
  });
});
test('task, target, report and findings require exact service ownership', async () => {
  for (const [route, key] of [
    ['/api/eval-tasks/:id', 'id'], ['/api/model-targets/:id', 'id'],
    ['/api/reports/:id', 'id'], ['/api/remediation/:findingId', 'findingId'],
  ]) {
    await check('GET', route, { [key]: 'own' });
    for (const id of ['foreign', 'legacy', 'missing']) {
      await assert.rejects(check('GET', route, { [key]: id }), { code: 'CONNECTOR_RESOURCE_NOT_FOUND' });
    }
  }
});
test('execution, generation and remediation references cannot cross owners', async () => {
  for (const [route, method, body] of [
    ['/api/agent-evals/run', 'POST', { modelTargetId: 'foreign' }],
    ['/api/agent-evals/run', 'POST', { modelTargetId: 'own', adaptiveOverride: { enabled: true, attackerTargetId: 'foreign' } }],
    ['/api/reports', 'POST', { taskId: 'foreign' }],
    ['/api/reports', 'POST', { taskId: 'own', explanationModelTargetId: 'foreign' }],
    ['/api/remediation/:findingId', 'PATCH', { retestTaskId: 'foreign' }],
    ['/api/eval-tasks/:id/retest-failed', 'POST', { findingId: 'foreign' }],
  ] as const) {
    await assert.rejects(check(method, route, { id: 'own', findingId: 'own' }, body), { code: 'CONNECTOR_RESOURCE_NOT_FOUND' });
  }
  await check('POST', '/api/agent-evals/run', {}, { modelTargetId: 'own' });
});
test('connector-created agent targets execute via standard eval-tasks create', async () => {
  await check('POST', '/api/eval-tasks', {}, { modelTargetId: 'own' });
  for (const targetId of ['foreign', 'legacy', 'missing']) {
    await assert.rejects(
      check('POST', '/api/eval-tasks', {}, { modelTargetId: targetId }),
      { code: 'CONNECTOR_RESOURCE_NOT_FOUND' },
    );
  }
});
test('delete, admin, summary and new routes fail closed even with broader grants or builtin flag', async () => {
  for (const [method, route] of [
    ['DELETE', '/api/reports/:id'], ['GET', '/api/eval-tasks/risk-summary'],
    ['GET', '/api/users'], ['GET', '/api/reports/trend'], ['POST', '/api/new-engine/run'],
  ]) {
    await assert.rejects(check(method, route, { id: 'own' }, {}, user(true, true)), { code: 'CONNECTOR_OPERATION_DENIED' });
  }
});
test('ordinary product users preserve prior access and lists scope only connector', async () => {
  await check('DELETE', '/api/reports/:id', { id: 'foreign' }, {}, user(false));
  assert.deepEqual(connectorOwnerWhere(user()), { createdById: 'service' });
  assert.deepEqual(connectorOwnerWhere(user(false)), {});
});
test('Fastify hook denies unauthorized operation before mutation handler runs', async () => {
  const app = Fastify();
  let effects = 0;
  app.addHook('preHandler', async request => enforcePlatformConnectorAccess(user(), request, store));
  app.setErrorHandler((error, _request, reply) => reply.code(403).send({ code: error.code }));
  app.delete('/api/reports/:id', async () => { effects++; return {}; });
  app.post('/api/agent-evals/run', async () => { effects++; return {}; });
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/reports/own' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/agent-evals/run', payload: { modelTargetId: 'foreign' } })).statusCode, 403);
  assert.equal(effects, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/agent-evals/run', payload: { modelTargetId: 'own' } })).statusCode, 200);
  assert.equal(effects, 1);
  await app.close();
});

test('connector cannot create system judge or gateway-log targets', async () => {
  for (const targetType of ['JUDGE', 'GATEWAY_LOG', 'MODEL']) {
    await assert.rejects(check('POST', '/api/model-targets', {}, { targetType }), { code: 'CONNECTOR_TARGET_TYPE_DENIED' });
  }
  await check('POST', '/api/model-targets', {}, { targetType: 'AGENT_API' });
  await check('POST', '/api/model-targets', {}, { targetType: 'AGENT' });
});
test('named connector role stays restricted even if marker grant is removed', async () => {
  const actor = { ...user(false), roles: ['platform_connector'] };
  await assert.rejects(check('DELETE', '/api/reports/:id', { id: 'own' }, {}, actor), { code: 'CONNECTOR_OPERATION_DENIED' });
});

test('permission catalog admits sealed role without restricting ordinary administrators', async () => {
  assert.ok(PERMISSION_CODES.includes(CONNECTOR_RESTRICTED));
  const admin = ROLE_DEFS.find((role) => role.name === 'admin');
  assert.ok(admin);
  assert.ok(!admin.permissions.includes(CONNECTOR_RESTRICTED));
  const actor = { ...user(false, true), roles: ['admin'], permissions: new Set(admin.permissions) } as CurrentUser;
  await check('DELETE', '/api/reports/:id', { id: 'foreign' }, undefined, actor);
  const sealed = { ...actor, roles: ['admin', 'platform_connector'] } as CurrentUser;
  await assert.rejects(check('DELETE', '/api/reports/:id', { id: 'own' }, undefined, sealed));
});
