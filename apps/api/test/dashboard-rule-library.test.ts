import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { RETIRED_BUILTIN_SET_SOURCES } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { clearRuleLibraryCache } from '../src/modules/dashboard/rule-library.js';

// 2.2.1 规则库统计：/api/dashboard/rule-library（不随统计周期变化，单独取，服务端按租户范围缓存 60 秒）。
// 口径：按当前租户范围计数（本租户 + 平台内置/共享），别的租户的不算；
// 题集与题目只算样本库（种子库 + 自有），运行记录、已下线的内置库和已下线、尚未生效的题不算；
// 关键词只算生效的（候选、停用、已剔除都不算）；智能体样本按样本库页可见范围计数。
const TAG = `rl${randomUUID().slice(0, 8)}`;
const PREFIX = `__dash_rule_lib_${TAG}_`;
const PW = ['Tenant', 'Admin', '12345'].join('!');

let app!: FastifyInstance;
let adminToken = '';
let platformTenantId = '';
const tenants: Record<'a' | 'b', { id: string; token: string }> = {
  a: { id: '', token: '' },
  b: { id: '', token: '' },
};

type RuleLibrary = {
  questionSets: number;
  questions: number;
  keywords: number;
  agentSamples: number;
};

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token;
}

async function readRuleLibrary(
  token: string,
  headers: Record<string, string> = {},
): Promise<RuleLibrary> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/dashboard/rule-library',
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

/** 取最新统计：先清掉服务端 60 秒缓存，否则测试里刚造的数据要等缓存过期才看得到。 */
async function ruleLibrary(token: string, headers: Record<string, string> = {}) {
  clearRuleLibraryCache();
  return readRuleLibrary(token, headers);
}

const ALL_TENANTS = { 'x-lse-tenant': 'all' };

function delta(after: RuleLibrary, before: RuleLibrary): RuleLibrary {
  return {
    questionSets: after.questionSets - before.questionSets,
    questions: after.questions - before.questions,
    keywords: after.keywords - before.keywords,
    agentSamples: after.agentSamples - before.agentSamples,
  };
}

async function makeSet(
  label: string,
  opts: {
    tenantId: string | null;
    questions: number;
    isBuiltin?: boolean;
    source?: string | null;
    retiredQuestions?: number;
    /** 自动更新进行中、尚未生效的题数（metadata.pendingVersion），排在下线题之后。 */
    pendingQuestions?: number;
  },
) {
  const set = await prisma.questionSet.create({
    data: {
      name: `${PREFIX}${label}`,
      tenantId: opts.tenantId,
      isBuiltin: opts.isBuiltin ?? false,
      source: opts.source ?? null,
    },
  });
  const rows = Array.from({ length: opts.questions }, (_, i) => ({
    questionSetId: set.id,
    tenantId: opts.tenantId,
    content: `${PREFIX}${label}-${i}`,
    metadata:
      i < (opts.retiredQuestions ?? 0)
        ? { retired: true }
        : i < (opts.retiredQuestions ?? 0) + (opts.pendingQuestions ?? 0)
          ? { pendingVersion: '2026.11' }
          : undefined,
  }));
  if (rows.length) await prisma.question.createMany({ data: rows });
  return set.id;
}

async function makeKeyword(term: string, tenantId: string | null, reviewStatus = 'approved') {
  await prisma.standardKeyword.create({
    data: { tenantId, itemCode: 'A.2.e', term: `${PREFIX}${term}`, source: 'manual', reviewStatus },
  });
}

async function makeAgentSample(id: string, tenantId: string | null) {
  await prisma.agentSample.create({
    data: { id: `${PREFIX}${id}`, tenantId, suite: 'runtime_v2', source: 'custom' },
  });
}

async function cleanup(): Promise<void> {
  await prisma.agentSample.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.standardKeyword.deleteMany({ where: { term: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const ids = [tenants.a.id, tenants.b.id].filter(Boolean);
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }
}

before(async () => {
  app = await buildApp();
  await app.ready();
  adminToken = await login('admin', 'Admin@12345'); // pragma: allowlist secret
  platformTenantId = (await prisma.tenant.findFirstOrThrow({ where: { isPlatform: true } })).id;
  for (const key of ['a', 'b'] as const) {
    const username = `${TAG}${key}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: `${PREFIX}${key}`, admin: { username, password: PW } },
    });
    assert.equal(res.statusCode, 201, res.body);
    tenants[key].id = res.json().id;
    await skipFirstPasswordChange(username);
    tenants[key].token = await login(username, PW);
  }
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('规则库统计：题集、题目、关键词、智能体样本', async () => {
  const before = await ruleLibrary(adminToken);
  for (const key of ['questionSets', 'questions', 'keywords', 'agentSamples'] as const) {
    assert.equal(typeof before[key], 'number', key);
  }

  // 内置库 3 题，其中 1 题已下线；已下线的内置库整库不算。
  await makeSet('builtin', {
    tenantId: null,
    isBuiltin: true,
    source: `builtin:${TAG}`,
    questions: 3,
    retiredQuestions: 1,
  });
  await makeSet('retired-builtin', {
    tenantId: null,
    isBuiltin: true,
    source: RETIRED_BUILTIN_SET_SOURCES[0]!,
    questions: 2,
  });
  // 自有样本库算，运行记录不算。
  await makeSet('own', { tenantId: null, source: 'upload:custom.csv', questions: 4 });
  await makeSet('run', { tenantId: null, source: 'generator:abc', questions: 5 });
  // 关键词：只算生效的，候选、停用、已剔除的不算。
  await makeKeyword('k1', null, 'pending');
  await makeKeyword('k2', null, 'approved');
  await makeKeyword('k3', null, 'rejected');
  await makeKeyword('k4', null, 'disabled');
  await makeAgentSample('s1', null);

  const after = await ruleLibrary(adminToken);
  assert.deepEqual(delta(after, before), {
    questionSets: 2,
    questions: 6,
    keywords: 1,
    agentSamples: 1,
  });
});

test('租户只算本租户和平台内置，别的租户的不算', async () => {
  const beforeA = await ruleLibrary(tenants.a.token);
  const beforeB = await ruleLibrary(tenants.b.token);

  await makeSet('platform-builtin-2', {
    tenantId: null,
    isBuiltin: true,
    source: `builtin:${TAG}:2`,
    questions: 1,
  });
  await makeSet('a-own', { tenantId: tenants.a.id, source: 'upload:a.csv', questions: 2 });
  await makeSet('b-own', { tenantId: tenants.b.id, source: 'upload:b.csv', questions: 7 });
  await makeKeyword('a-k', tenants.a.id);
  await makeKeyword('b-k1', tenants.b.id);
  await makeKeyword('b-k2', tenants.b.id);
  await makeAgentSample('a-s', tenants.a.id);
  await makeAgentSample('b-s1', tenants.b.id);
  await makeAgentSample('b-s2', tenants.b.id);

  assert.deepEqual(delta(await ruleLibrary(tenants.a.token), beforeA), {
    questionSets: 2,
    questions: 3,
    keywords: 1,
    agentSamples: 1,
  });
  assert.deepEqual(delta(await ruleLibrary(tenants.b.token), beforeB), {
    questionSets: 2,
    questions: 8,
    keywords: 2,
    agentSamples: 2,
  });
});

test('内置库里自动更新进行中、尚未生效的题不算', async () => {
  const before = await ruleLibrary(adminToken);
  await makeSet('builtin-pending', {
    tenantId: null,
    isBuiltin: true,
    source: `builtin:${TAG}:pending`,
    questions: 5,
    retiredQuestions: 1,
    pendingQuestions: 2,
  });
  assert.deepEqual(delta(await ruleLibrary(adminToken), before), {
    questionSets: 1,
    questions: 2,
    keywords: 0,
    agentSamples: 0,
  });
});

test('平台租户视角：平台共享 + 平台租户自己的，不含其他租户', async () => {
  const before = await ruleLibrary(adminToken);
  await makeSet('platform-shared-3', {
    tenantId: null,
    isBuiltin: true,
    source: `builtin:${TAG}:3`,
    questions: 2,
  });
  await makeSet('platform-own', {
    tenantId: platformTenantId,
    source: 'upload:p.csv',
    questions: 3,
  });
  await makeSet('a-own-3', { tenantId: tenants.a.id, source: 'upload:a3.csv', questions: 11 });
  await makeKeyword('p-k', platformTenantId);
  await makeKeyword('a-k3', tenants.a.id);
  await makeAgentSample('p-s', platformTenantId);
  await makeAgentSample('a-s3', tenants.a.id);

  assert.deepEqual(delta(await ruleLibrary(adminToken), before), {
    questionSets: 2,
    questions: 5,
    keywords: 1,
    agentSamples: 1,
  });
});

test('全部租户视角：各租户与平台的都算', async () => {
  const before = await ruleLibrary(adminToken, ALL_TENANTS);
  await makeSet('all-shared', {
    tenantId: null,
    isBuiltin: true,
    source: `builtin:${TAG}:4`,
    questions: 1,
  });
  await makeSet('all-a', { tenantId: tenants.a.id, source: 'upload:a4.csv', questions: 2 });
  await makeSet('all-b', { tenantId: tenants.b.id, source: 'upload:b4.csv', questions: 4 });
  await makeSet('all-b-run', { tenantId: tenants.b.id, source: 'generator:b4', questions: 8 });
  await makeKeyword('all-a-k', tenants.a.id);
  await makeKeyword('all-b-k', tenants.b.id);
  await makeKeyword('all-b-rejected', tenants.b.id, 'rejected');
  await makeAgentSample('all-a-s', tenants.a.id);
  await makeAgentSample('all-b-s', tenants.b.id);

  assert.deepEqual(delta(await ruleLibrary(adminToken, ALL_TENANTS), before), {
    questionSets: 3,
    questions: 7,
    keywords: 2,
    agentSamples: 2,
  });
});

test('服务端按租户范围缓存 60 秒：缓存期内不重算，各租户各自一份', async () => {
  const first = await ruleLibrary(tenants.a.token);
  const otherTenant = await readRuleLibrary(tenants.b.token);
  await makeSet('cache-a', { tenantId: tenants.a.id, source: 'upload:cache.csv', questions: 3 });
  // 缓存期内：本租户仍是旧数，另一个租户的缓存不受影响
  assert.deepEqual(await readRuleLibrary(tenants.a.token), first);
  assert.deepEqual(await readRuleLibrary(tenants.b.token), otherTenant);
  // 缓存清掉后重算
  assert.deepEqual(delta(await ruleLibrary(tenants.a.token), first), {
    questionSets: 1,
    questions: 3,
    keywords: 0,
    agentSamples: 0,
  });
});

test('总览接口不再带规则库统计，切换统计周期不重算', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/dashboard/overview?period=7d',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ruleLibrary, undefined);
});
