import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { CONNECTOR_RESTRICTED, enforcePlatformConnectorAccess, type ConnectorAccessStore } from '../src/lib/platform-connector-access.js';
import { requirePermission } from '../src/plugins/auth.js';
import type { CurrentUser } from '../src/lib/rbac.js';

const config = { agentInstanceId: 'tri-agent', gatewayCredentialId: 'key-old', systemPrompt: 'Authorized synthetic task.',
  tools: [{ name: 'read_file', description: 'Simulated read only.', parameters: { type: 'object' }, dangerLevel: 'LOW', simulator: 'read_file' }],
  mcp: [], skills: [] };
const actor = (...grants: string[]) => ({ id: 'service', username: 'service', isBuiltin: false,
  permissions: new Set([CONNECTOR_RESTRICTED, ...grants]), roles: ['platform_connector'] }) as CurrentUser;
const user = actor('model_target:update', 'remediation:update');
const record = (id: string) => id === 'missing' ? null : ({ createdById: id === 'foreign' ? 'other' : id === 'legacy' ? null : 'service' });
const store: ConnectorAccessStore = {
  evalTask: { findUnique: async ({ where }) => record(where.id) },
  modelTarget: { findUnique: async ({ where }) => {
    const owned = record(where.id);
    return owned && { ...owned, targetType: where.id === 'model' ? 'MODEL' : 'AGENT', agentConfig: config, apiKey: 'synthetic-old-key' };
  } },
  report: { findUnique: async ({ where }) => ({ task: record(where.id) }) },
  finding: { findUnique: async ({ where }) => ({ task: record(where.id) }) },
};
const check = (route: string, params: unknown, body: unknown, who = user) =>
  enforcePlatformConnectorAccess(who, { method: 'PATCH', routeOptions: { url: route }, params, body }, store);
const targetRoute = '/api/model-targets/:id';
const reviewRoute = '/api/remediation/:findingId/review';
test('restricted owner updates full AGENT remediation snapshot or atomically rotates key binding', async () => {
  await check(targetRoute, { id: 'own' }, { agentConfig: { ...config, systemPrompt: 'Updated synthetic task.', mcp: [{ name: 'tri-mcp', description: 'Synthetic', enabled: false }] } });
  await check(targetRoute, { id: 'own' }, { apiKey: 'synthetic-new-key', agentConfig: { ...config, gatewayCredentialId: 'key-new' } });
  await check(reviewRoute, { findingId: 'own' }, { status: 'CONFIRMED', reason: 'Observed synthetic tool trace.' });
});
test('mutations require explicit native permission even for the restricted owner', async () => {
  await assert.rejects(check(targetRoute, { id: 'own' }, { agentConfig: config }, actor()), { code: 'CONNECTOR_PERMISSION_REQUIRED' });
  await assert.rejects(check(reviewRoute, { findingId: 'own' }, { status: 'CONFIRMED', reason: 'Trace.' }, actor()), { code: 'CONNECTOR_PERMISSION_REQUIRED' });
});
test('restricted mutations deny foreign, legacy and missing records and non-AGENT targets', async () => {
  for (const id of ['foreign', 'legacy', 'missing']) {
    await assert.rejects(check(targetRoute, { id }, { agentConfig: config }), { code: 'CONNECTOR_RESOURCE_NOT_FOUND' });
    await assert.rejects(check(reviewRoute, { findingId: id }, { status: 'CONFIRMED', reason: 'Trace.' }), { code: 'CONNECTOR_RESOURCE_NOT_FOUND' });
  }
  await assert.rejects(check(targetRoute, { id: 'model' }, { agentConfig: config }), { code: 'CONNECTOR_TARGET_TYPE_DENIED' });
});
test('restricted AGENT patch cannot alter owner, origin, model, type or instance identity', async () => {
  for (const field of ['createdById', 'name', 'baseUrl', 'model', 'targetType', 'extraHeaders', 'isGlobal', 'isActive', 'accessConfig'])
    await assert.rejects(check(targetRoute, { id: 'own' }, { agentConfig: config, [field]: 'tampered' }), { code: 'CONNECTOR_MUTATION_FIELDS_DENIED' });
  await assert.rejects(check(targetRoute, { id: 'own' }, { agentConfig: { ...config, agentInstanceId: 'other-agent' } }), { code: 'CONNECTOR_AGENT_IDENTITY_IMMUTABLE' });
  for (const payload of [{}, { agentConfig: null }, { agentConfig: { agentInstanceId: 'tri-agent' } },
    { apiKey: 'synthetic-new-key' }, { apiKey: 'synthetic-new-key', agentConfig: config },
    { agentConfig: { ...config, gatewayCredentialId: 'key-new' } }])
    await assert.rejects(check(targetRoute, { id: 'own' }, payload));
});
test('restricted finding review only confirms with a nonempty reason and exact fields', async () => {
  for (const status of ['DISMISSED', 'FALSE_POSITIVE', 'UNREVIEWED', 'NEEDS_REVIEW', 'ACCEPTED_RISK'])
    await assert.rejects(check(reviewRoute, { findingId: 'own' }, { status, reason: 'Trace.' }), { code: 'CONNECTOR_MUTATION_FIELDS_DENIED' });
  for (const payload of [{ status: 'CONFIRMED' }, { status: 'CONFIRMED', reason: ' ' },
    { status: 'CONFIRMED', reason: 'Trace.', createdById: 'other' }, { status: 'CONFIRMED', reason: 'Trace.', owner: 'other' }])
    await assert.rejects(check(reviewRoute, { findingId: 'own' }, payload), { code: 'CONNECTOR_MUTATION_FIELDS_DENIED' });
});
test('native route permission and connector boundary deny before any mutation', async () => {
  const app = Fastify();
  let effects = 0;
  app.addHook('preHandler', async request => {
    request.currentUser = user;
    await enforcePlatformConnectorAccess(user, request, store);
  });
  app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 403).send({ code: error.code }));
  app.patch(targetRoute, { preHandler: [requirePermission('model_target:update')] }, async () => { effects++; return { ok: true }; });
  app.patch(reviewRoute, { preHandler: [requirePermission('remediation:update')] }, async () => { effects++; return { ok: true }; });
  const rotation = { apiKey: 'synthetic-new-key', agentConfig: { ...config, gatewayCredentialId: 'key-new' } };
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-targets/own', payload: rotation })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-targets/foreign', payload: rotation })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-targets/own', payload: { ...rotation, baseUrl: 'https://other.invalid/v1' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/remediation/own/review', payload: { status: 'CONFIRMED', reason: 'Trace.' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/remediation/own/review', payload: { status: 'FALSE_POSITIVE', reason: 'Trace.' } })).statusCode, 403);
  assert.equal(effects, 2);
  await app.close();
});
