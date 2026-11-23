import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentConfig, bindAgentIdentity, generateTriAgentScenarios } from '../src/modules/agent-evals/agent-target.js';
import { chatCompleteWithTools } from '../src/lib/llm-client.js';
import { runAgentScenario } from '../src/modules/agent-evals/runner.js';
import { CONNECTOR_RESTRICTED, enforcePlatformConnectorAccess, type ConnectorAccessStore } from '../src/lib/platform-connector-access.js';
import type { CurrentUser } from '../src/lib/rbac.js';

const fixtureKey = 'jjd_' + 'a'.repeat(48), overrideKey = 'jjd_' + 'b'.repeat(48);
const cfg = { baseUrl: 'https://127.0.0.1:28880/v1', apiKey: fixtureKey, model: 'synthetic-model' };
const agent = parseAgentConfig({ agentInstanceId: 'uai_fixture', gatewayCredentialId: 'key_fixture', systemPrompt: 'Synthetic only.',
  tools: [{ name: 'read_file', description: 'Simulated read.', parameters: { type: 'object' }, dangerLevel: 'LOW', simulator: 'read_file' }], mcp: [], skills: [] });
const actor = { id: 'fixture-owner', roles: ['platform_connector'], permissions: new Set([CONNECTOR_RESTRICTED, 'model_target:create', 'model_target:update']) } as CurrentUser;
const envNames = ['LSE_AGENT_GATEWAY_ORIGINS', 'LSE_TARGET_EGRESS_ALLOWLIST', 'LSE_TARGET_EGRESS_ALLOW_PRIVATE', 'LSE_TARGET_EGRESS_POLICIES', 'LSE_CORRELATION_HMAC_KEYS'] as const;
const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
process.env.LSE_AGENT_GATEWAY_ORIGINS = 'https://127.0.0.1:28880';
process.env.LSE_TARGET_EGRESS_ALLOWLIST = 'https://127.0.0.1:28880';
process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';
delete process.env.LSE_TARGET_EGRESS_POLICIES;
delete process.env.LSE_CORRELATION_HMAC_KEYS;
after(() => { for (const name of envNames) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
const names = ['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie', 'x-auth-token', 'x-goog-api-key'];
const variants = names.flatMap(name => [name, name.toUpperCase(), name.replace(/(^|-)([a-z])/g, (_all, prefix, character) => prefix + character.toUpperCase())]);

test('AGENT native binding rejects authentication headers without exposing credentials', () => {
  for (const name of variants) {
    assert.throws(() => bindAgentIdentity({ ...cfg, extraHeaders: { [name]: 'Bearer ' + overrideKey } }, agent),
      error => error instanceof Error && (error as Error & { code?: string }).code === 'AGENT_AUTH_HEADER_FORBIDDEN' && !error.message.includes(overrideKey));
  }
});

test('restricted AGENT create and dirty stored update fail before any native mutation', async () => {
  for (const name of variants) {
    const extraHeaders = { [name]: 'Bearer ' + overrideKey };
    await assert.rejects(enforcePlatformConnectorAccess(actor, { method: 'POST', routeOptions: { url: '/api/model-targets' }, body: { targetType: 'AGENT', ...cfg, agentConfig: agent, extraHeaders } }, {} as ConnectorAccessStore), { code: 'AGENT_AUTH_HEADER_FORBIDDEN' });
    const store = { modelTarget: { findUnique: async () => ({ createdById: actor.id, targetType: 'AGENT', agentConfig: agent, apiKey: fixtureKey, extraHeaders }) } } as unknown as ConnectorAccessStore;
    await assert.rejects(enforcePlatformConnectorAccess(actor, { method: 'PATCH', routeOptions: { url: '/api/model-targets/:id' }, params: { id: 'owned' }, body: { agentConfig: agent } }, store), { code: 'AGENT_AUTH_HEADER_FORBIDDEN' });
  }
  await enforcePlatformConnectorAccess(actor, { method: 'POST', routeOptions: { url: '/api/model-targets' }, body: { targetType: 'AGENT', extraHeaders: { 'X-Business-Label': 'fixture' } } }, {} as ConnectorAccessStore);
});

test('dirty saved AGENT runtime cannot reach the actual client transport', async () => {
  let requests = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error('transport must not run'); };
  try {
    for (const name of variants) await assert.rejects(runAgentScenario({ ...cfg, extraHeaders: { [name]: 'Bearer ' + overrideKey } }, generateTriAgentScenarios(agent, 'fixture')[0]!), { code: 'AGENT_AUTH_HEADER_FORBIDDEN' });
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('actual client sends bound AGENT apiKey and business headers while MODEL behavior stays compatible', async () => {
  const previousFetch = globalThis.fetch;
  const captured: Headers[] = [];
  globalThis.fetch = async (_url, init) => {
    captured.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'synthetic' }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const original = { 'X-Business-Label': 'fixture', 'x-agent-instance-id': agent.agentInstanceId };
    const bound = bindAgentIdentity({ ...cfg, extraHeaders: original }, agent);
    assert.equal((await chatCompleteWithTools(bound, [{ role: 'user', content: 'Synthetic.' }], [])).status, 'SUCCESS');
    assert.equal(captured[0]!.get('authorization'), 'Bearer ' + fixtureKey);
    assert.equal(captured[0]!.get('x-agent-instance-id'), agent.agentInstanceId);
    assert.equal(captured[0]!.get('x-business-label'), 'fixture');
    assert.deepEqual(original, { 'X-Business-Label': 'fixture', 'x-agent-instance-id': agent.agentInstanceId });
    assert.equal((await chatCompleteWithTools({ ...cfg, extraHeaders: { authorization: 'Bearer ' + overrideKey } }, [{ role: 'user', content: 'Synthetic MODEL compatibility.' }], [])).status, 'SUCCESS');
    assert.equal(captured[1]!.get('authorization'), 'Bearer ' + overrideKey);
    assert.equal(captured[1]!.get('x-agent-instance-id'), null);
  } finally { globalThis.fetch = previousFetch; }
});
