import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { attackSeedDeps } from '../src/modules/question-sets/attack-seeds/routes.js';
import { RED_TEAM_SETTING_KEY } from '../src/modules/red-team/config.js';

const PFX = 'ATKSEED_';
const AUDITOR = 'attack_seed_auditor';
const AUDITOR_PW = ['Attack', 'Seed', '12345'].join('!');
let app: Awaited<ReturnType<typeof buildApp>>;
let admin = '';
let auditor = '';
let prevSetting: unknown = undefined;
const realChat = attackSeedDeps.chat;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const spec = {
  domain: `${PFX}油气管网`,
  scope: '调控中心',
  focus: '身份冒用',
  keywords: ['值班长'],
  scenarioCount: 2,
  questionsPerScenario: 3,
  binding: { taxonomy: 'energy', categories: ['ENERGY.impersonation'] },
};

async function cleanup() {
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.testDomain.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: AUDITOR } });
}
async function login(username: string, password: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().token as string;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  await prisma.user.create({
    data: {
      username: AUDITOR,
      passwordHash: await argon2.hash(AUDITOR_PW, { type: argon2.argon2id }),
      displayName: '攻击种子审计员',
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  admin = await login('admin', ['Admin', '@', '12345'].join(''));
  auditor = await login(AUDITOR, AUDITOR_PW);
  prevSetting = (await prisma.systemSetting.findUnique({ where: { key: RED_TEAM_SETTING_KEY } }))
    ?.value;
});

after(async () => {
  attackSeedDeps.chat = realChat;
  if (prevSetting === undefined) {
    await prisma.systemSetting.deleteMany({ where: { key: RED_TEAM_SETTING_KEY } });
  } else {
    await prisma.systemSetting.update({
      where: { key: RED_TEAM_SETTING_KEY },
      data: { value: prevSetting as object },
    });
  }
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

async function setAttacker(id: string) {
  await prisma.systemSetting.upsert({
    where: { key: RED_TEAM_SETTING_KEY },
    update: { value: { attackerTargetId: id } },
    create: { key: RED_TEAM_SETTING_KEY, value: { attackerTargetId: id } },
  });
}

test('权限：无 generator:run 的用户生成返回 403', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/question-sets/attack-seeds/generate',
    headers: auth(auditor),
    payload: spec,
  });
  assert.equal(r.statusCode, 403, r.body);
});

test('上限：场景数 51 返回 400', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/question-sets/attack-seeds/generate',
    headers: auth(admin),
    payload: { ...spec, scenarioCount: 51 },
  });
  assert.equal(r.statusCode, 400, r.body);
});

test('回退路径：未配置攻击模型 → 模板生成，写审计', async () => {
  await setAttacker('');
  const r = await app.inject({
    method: 'POST',
    url: '/api/question-sets/attack-seeds/generate',
    headers: auth(admin),
    payload: spec,
  });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.source, 'template');
  assert.equal(body.total, 6);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'attack_seed.generate' },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal((audit?.detail as { source?: string }).source, 'template');
});

test('LLM 路径：调用主攻击模型（mock），标明攻击模型生成', async () => {
  const t = await prisma.modelTarget.create({
    data: {
      name: `${PFX}攻击模型`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-x',
      model: 'atk-model',
    },
  });
  await setAttacker(t.id);
  let seenModel = '';
  attackSeedDeps.chat = async (cfg) => {
    seenModel = cfg.model;
    return {
      status: 'SUCCESS',
      content: JSON.stringify({
        scenarios: [
          { name: '冒充值班长', category: 'ENERGY.impersonation', questions: ['a', 'b', 'c'] },
        ],
      }),
      finishReason: 'stop',
      model: 'atk-model',
      latencyMs: 1,
      httpStatus: 200,
      error: null,
      raw: null,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  };
  const r = await app.inject({
    method: 'POST',
    url: '/api/question-sets/attack-seeds/generate',
    headers: auth(admin),
    payload: spec,
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(seenModel, 'atk-model');
  assert.equal(r.json().source, 'attacker_model');
  assert.equal(r.json().attackerModel, `${PFX}攻击模型`);
  assert.ok(!r.body.includes('sk-x'), '响应不得回显凭据');
});

test('领域持久化 + 保存为自有题库（记录领域/绑定标准/场景元数据）', async () => {
  const d = await app.inject({
    method: 'POST',
    url: '/api/question-sets/attack-seeds/domains',
    headers: auth(admin),
    payload: { name: `${PFX}新领域` },
  });
  assert.equal(d.statusCode, 201, d.body);
  const list = await app.inject({
    method: 'GET',
    url: '/api/question-sets/attack-seeds/domains',
    headers: auth(admin),
  });
  assert.ok(list.json().items.some((x: { name: string }) => x.name === `${PFX}新领域`));
  const save = await app.inject({
    method: 'POST',
    url: '/api/question-sets/attack-seeds/save',
    headers: auth(admin),
    payload: {
      name: `${PFX}题库`,
      spec,
      source: 'template',
      scenarios: [{ name: '场景1', category: 'ENERGY.impersonation', questions: ['q1', 'q2'] }],
    },
  });
  assert.equal(save.statusCode, 201, save.body);
  const set = await prisma.questionSet.findUniqueOrThrow({
    where: { id: save.json().id },
    include: { questions: true },
  });
  assert.equal(set.isBuiltin, false);
  assert.equal(set.questions.length, 2);
  const meta = set.metadata as {
    domain: { name: string };
    binding: { taxonomy: string };
    generationSource: string;
    scenarios: unknown[];
  };
  assert.equal(meta.domain.name, spec.domain);
  assert.equal(meta.binding.taxonomy, 'energy');
  assert.equal(meta.generationSource, 'template');
  assert.equal(meta.scenarios.length, 1);
  assert.ok(
    // 测试领域的唯一键改成 (tenantId, name) 了，按名字查要用 findFirst。
    await prisma.testDomain.findFirst({ where: { name: spec.domain } }),
    '保存时自动持久化领域',
  );
});
