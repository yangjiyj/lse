import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { syncGbt45654Banks } from '../src/modules/question-sets/builtin/gbt45654-bank.js';
import { bankUpdateRouteDeps } from '../src/modules/question-sets/bank-updates/routes.js';
import { hasPendingManualJob, hasQueuedJob } from '../src/modules/question-sets/bank-updates/queue.js';
import { nextRunOf } from '../src/modules/question-sets/bank-updates/service.js';
import { bankUpdateNote } from '../src/modules/reports/specialized/gbt45654-content.js';
import { GBT_SAMPLING_ALGORITHM_VERSION } from '../src/modules/standard-evaluations/gbt45654/constants.js';
import { sampleBank, type BankQuestion } from '../src/modules/standard-evaluations/gbt45654/sampling.js';
import { BANK_SOURCES } from '@lse/shared';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

const AUDITOR = 'bank_update_auditor';
const AUDITOR_PW = ['Bank', 'Update', '12345'].join('!');
let app: Awaited<ReturnType<typeof buildApp>>;
let admin = '';
let auditor = '';
const realEnqueue = bankUpdateRouteDeps.enqueue;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function login(username: string, password: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().token as string;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await syncGbt45654Banks(prisma);
  await prisma.gbtBankUpdate.deleteMany({});
  await prisma.user.deleteMany({ where: { username: AUDITOR } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  await prisma.user.create({
    data: {
      username: AUDITOR,
      passwordHash: await argon2.hash(AUDITOR_PW, { type: argon2.argon2id }),
      displayName: '题库更新审计员',
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  admin = await login('admin', ['Admin', '@', '12345'].join(''));
  auditor = await login(AUDITOR, AUDITOR_PW);
});

after(async () => {
  bankUpdateRouteDeps.enqueue = realEnqueue;
  await prisma.gbtBankUpdate.deleteMany({});
  await prisma.auditLog.deleteMany({ where: { action: 'question_set.bank_update_run' } });
  await prisma.user.deleteMany({ where: { username: AUDITOR } });
  await app.close();
  await prisma.$disconnect();
});

test('GET /updates：记录、当前版本、周期说明与下次计划时间；只读权限即可看', async () => {
  const now = new Date();
  await prisma.gbtBankUpdate.createMany({
    data: [
      { kind: 'questions', version: '2026.11.4', trigger: 'release', status: 'succeeded', startedAt: new Date(now.getTime() - 4000), finishedAt: new Date(now.getTime() - 3000), note: '随产品版本发布' },
      { kind: 'keywords', version: '2026-11-17', trigger: 'schedule', status: 'succeeded', startedAt: new Date(now.getTime() - 2000), finishedAt: new Date(now.getTime() - 1000), added: { 'A.1.a': 2, 'A.2.e': 3 } },
    ],
  });
  const r = await app.inject({ method: 'GET', url: '/api/question-sets/builtin/updates', headers: auth(auditor) });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].kind, 'keywords', '最新的在前');
  assert.equal(body.questions.cadence, '每月 1 日自动更新');
  assert.equal(body.keywords.cadence, '每周一自动补充');
  assert.equal(body.keywords.lastAdded, 5);
  assert.equal(body.keywords.version, '2026-11-17');
  assert.equal(body.questions.running, false);
  assert.ok(body.questions.version);
  const next = new Date(body.questions.nextRunAt);
  assert.equal(next.getTime() > now.getTime(), true);
  // 每月 1 日 03:00（上海）= 前一天 19:00 UTC
  assert.equal(next.getUTCHours(), 19);
  assert.equal(new Date(body.keywords.nextRunAt).getTime() > now.getTime(), true);
  assert.equal(nextRunOf('0 3 1 * *', new Date('2026-11-15T00:00:00Z'))!.toISOString(), '2026-11-30T19:00:00.000Z');
  assert.equal(nextRunOf('0 3 * * 1', new Date('2026-11-15T00:00:00Z'))!.toISOString(), '2026-11-15T19:00:00.000Z');
});

test('POST /updates/run：无 question_set:update 权限 403；有权限加入队列；已有同类在跑返回提示', async () => {
  const denied = await app.inject({ method: 'POST', url: '/api/question-sets/builtin/updates/run', headers: auth(auditor), payload: { kind: 'questions' } });
  assert.equal(denied.statusCode, 403, denied.body);

  const queued: unknown[] = [];
  bankUpdateRouteDeps.enqueue = async (data) => {
    queued.push(data);
  };
  const bad = await app.inject({ method: 'POST', url: '/api/question-sets/builtin/updates/run', headers: auth(admin), payload: { kind: 'x' } });
  assert.equal(bad.statusCode >= 400 && bad.statusCode < 500, true);

  const r = await app.inject({ method: 'POST', url: '/api/question-sets/builtin/updates/run', headers: auth(admin), payload: { kind: 'keywords' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().started, true);
  assert.deepEqual(queued, [{ kind: 'keywords', trigger: 'manual', actorName: 'admin' }]);
  const audit = await prisma.auditLog.findFirst({ where: { action: 'question_set.bank_update_run' }, orderBy: { createdAt: 'desc' } });
  assert.equal(audit?.actorName, 'admin');

  await prisma.gbtBankUpdate.create({ data: { kind: 'keywords', version: '2026-11-18', trigger: 'manual', status: 'running' } });
  const again = await app.inject({ method: 'POST', url: '/api/question-sets/builtin/updates/run', headers: auth(admin), payload: { kind: 'keywords' } });
  assert.equal(again.json().started, false);
  assert.match(again.json().message, /正在进行/);
  assert.equal(queued.length, 1, '没有重复入队');
  // 另一类不受影响
  const q = await app.inject({ method: 'POST', url: '/api/question-sets/builtin/updates/run', headers: auth(admin), payload: { kind: 'questions' } });
  assert.equal(q.json().started, true);
});

test('立即更新只给平台租户的平台管理员：租户管理员不显示按钮、调用 403；发起审计记在平台租户', async () => {
  const tag = `bkr${Date.now()}`;
  const PW = ['Tenant', 'Admin', '12345'].join('!');
  const created = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: auth(admin),
    payload: { name: `${tag}租户`, admin: { username: tag, password: PW } },
  });
  assert.equal(created.statusCode, 201, created.body);
  const tenantId = created.json().id as string;
  try {
    await skipFirstPasswordChange(tag);
    const tenantAdmin = await login(tag, PW);
    const view = await app.inject({ method: 'GET', url: '/api/question-sets/builtin/updates', headers: auth(tenantAdmin) });
    assert.equal(view.statusCode, 200, view.body);
    assert.equal(view.json().canRun, false);
    assert.equal((await app.inject({ method: 'GET', url: '/api/question-sets/builtin/updates', headers: auth(auditor) })).json().canRun, false);
    assert.equal((await app.inject({ method: 'GET', url: '/api/question-sets/builtin/updates', headers: auth(admin) })).json().canRun, true);

    let queued = 0;
    bankUpdateRouteDeps.enqueue = async () => {
      queued += 1;
    };
    for (const kind of ['questions', 'keywords']) {
      const r = await app.inject({ method: 'POST', url: '/api/question-sets/builtin/updates/run', headers: auth(tenantAdmin), payload: { kind } });
      assert.equal(r.statusCode, 403, r.body);
    }
    assert.equal(queued, 0, '租户管理员不能触发全平台共享题库的更新');

    await prisma.gbtBankUpdate.deleteMany({ where: { status: 'running' } });
    const ok = await app.inject({ method: 'POST', url: '/api/question-sets/builtin/updates/run', headers: auth(admin), payload: { kind: 'questions' } });
    assert.equal(ok.json().started, true, ok.body);
    assert.equal(queued, 1);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'question_set.bank_update_run' }, orderBy: { createdAt: 'desc' } });
    assert.equal(audit?.tenantId, PLATFORM_TENANT_ID);
  } finally {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  }
});

test('「立即更新」查重：等待或执行中的同类任务不论手动定时都算，延时的只算手动', () => {
  const job = (kind: 'questions' | 'keywords', trigger: 'schedule' | 'manual') => ({ data: { kind, trigger } });
  assert.equal(hasQueuedJob([job('questions', 'schedule')], [], 'questions'), true, '定时任务在排队');
  assert.equal(hasQueuedJob([], [job('questions', 'schedule')], 'questions'), false, '预放的下次执行不算');
  assert.equal(hasQueuedJob([], [job('questions', 'manual')], 'questions'), true);
  assert.equal(hasQueuedJob([job('keywords', 'schedule')], [], 'questions'), false);
});

test('复制为自有题库：只复制在用题，已下线和尚未生效的不复制', async () => {
  const gen = await prisma.questionSet.findFirstOrThrow({ where: { source: BANK_SOURCES.generation, tenantId: null } });
  const tpl = await prisma.question.findFirstOrThrow({ where: { questionSetId: gen.id } });
  const extra = (externalId: string, metadata: object) =>
    prisma.question.create({
      data: {
        questionSetId: gen.id,
        tenantId: null,
        externalId,
        content: externalId,
        category: tpl.category,
        expectedBehavior: tpl.expectedBehavior,
        type: tpl.type,
        severity: tpl.severity,
        shouldRefuse: tpl.shouldRefuse,
        language: 'zh',
        tags: tpl.tags,
        metadata,
      },
    });
  const pending = await extra(`${BANK_SOURCES.generation}:auto-2099.02.1-A.1.a-1`, { bank: 'generation', annexItem: 'A.1.a', pendingVersion: '2099.02.1' });
  const retired = await extra(`${BANK_SOURCES.generation}:auto-2099.01.1-A.1.a-1`, { bank: 'generation', annexItem: 'A.1.a', retired: true, retiredBy: 'rotation' });
  const name = `复制测试${Date.now()}`;
  let copyId = '';
  try {
    const inUse = (
      await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "questions" q WHERE q."questionSetId" = ${gen.id}
          AND COALESCE(q."metadata"->>'retired', 'false') <> 'true' AND (q."metadata"->>'pendingVersion') IS NULL`
    )[0]!.n;
    const r = await app.inject({ method: 'POST', url: `/api/question-sets/${gen.id}/copy`, headers: auth(admin), payload: { name } });
    assert.equal(r.statusCode, 201, r.body);
    copyId = r.json().id;
    assert.equal(r.json().questionCount, inUse);
    assert.equal(await prisma.question.count({ where: { questionSetId: copyId, externalId: { in: [pending.externalId!, retired.externalId!] } } }), 0);
  } finally {
    if (copyId) {
      await prisma.question.deleteMany({ where: { questionSetId: copyId } });
      await prisma.questionSet.delete({ where: { id: copyId } });
    }
    await prisma.question.deleteMany({ where: { id: { in: [pending.id, retired.id] } } });
    await prisma.auditLog.deleteMany({ where: { action: 'question_set.copy', targetId: copyId || 'none' } });
  }
});

test('/builtin/stats：自动更新进行中、尚未生效的题不计入题量与分类', async () => {
  const stats = async () => (await app.inject({ method: 'GET', url: '/api/question-sets/builtin/stats', headers: auth(admin) })).json();
  const before = await stats();
  const gen = await prisma.questionSet.findFirstOrThrow({ where: { source: BANK_SOURCES.generation, tenantId: null } });
  const tpl = await prisma.question.findFirstOrThrow({ where: { questionSetId: gen.id } });
  const q = await prisma.question.create({
    data: {
      questionSetId: gen.id,
      tenantId: null,
      externalId: `${BANK_SOURCES.generation}:auto-2099.01.1-A.1.a-1`,
      content: '待生效题样例',
      category: tpl.category,
      expectedBehavior: tpl.expectedBehavior,
      type: tpl.type,
      severity: tpl.severity,
      shouldRefuse: tpl.shouldRefuse,
      language: 'zh',
      tags: tpl.tags,
      metadata: { bank: 'generation', annexItem: 'A.1.a', addedInVersion: '2099.01.1', pendingVersion: '2099.01.1' },
    },
  });
  try {
    const after = await stats();
    assert.equal(after.builtinQuestionTotal, before.builtinQuestionTotal);
    assert.deepEqual(after.categories, before.categories);
  } finally {
    await prisma.question.delete({ where: { id: q.id } });
  }
});

test('报告题库说明：版本取冻结的抽样计划，日期按版本查记录，查不到不写日期', () => {
  const tail = '平台按附录 B.1 c)、B.2 d)、B.3 c) 设置：题库每月 1 日自动更新，关键词每周一自动补充。';
  const banks = { generation: { version: '2026.11.4' }, refusal: { version: '2026.11.4' }, non_refusal: { version: '2026.11.4' } };
  assert.equal(bankUpdateNote(banks, { '2026.11.4': '2026-11-15' }), `题库版本 2026.11.4（更新于 2026-11-15）。${tail}`);
  assert.equal(bankUpdateNote(banks, {}), `题库版本 2026.11.4。${tail}`);
  assert.equal(bankUpdateNote({ generation: { version: '2026.11.9' }, refusal: { version: '2026.11.10' } }, {}), `题库版本 2026.11.10。${tail}`);
  assert.equal(bankUpdateNote({}, {}), tail);
});

// ── 抽样偏向新题 ───────────────────────────────────────

function bankFixture(): BankQuestion[] {
  const out: BankQuestion[] = [];
  for (const key of ['信仰', '制度']) {
    for (let i = 0; i < 40; i += 1) {
      out.push({ id: `${key}-${String(i).padStart(3, '0')}`, annexItem: null, aspect: key, clauseIds: [], addedInVersion: i < 10 ? '2026.12.1' : i < 20 ? '2026.11.9' : null });
    }
  }
  return out;
}

test('抽样偏向新题：每层最多 30% 取最近一次自动更新的新题，同种子可复现，没有新版本时与旧算法一致', () => {
  assert.equal(GBT_SAMPLING_ALGORITHM_VERSION, 'mulberry32-v2-fresh30');
  const bank = bankFixture();
  const pick = (opts: { freshVersion?: string | null }) =>
    sampleBank('non_refusal', bank, { requested: 20, seed: 'seed-1', ...opts });
  const a = pick({ freshVersion: '2026.12.1' });
  const b = pick({ freshVersion: '2026.12.1' });
  assert.deepEqual(a.items.map((q) => q.id), b.items.map((q) => q.id), '可复现');
  // 13 个方面里只有 2 个有题，目标 20 题，层内配额由 allocateStrata 决定
  const total = a.items.length;
  const freshCount = a.items.filter((q) => q.addedInVersion === '2026.12.1').length;
  assert.equal(total, 20);
  assert.equal(freshCount, a.fresh.selected);
  assert.ok(freshCount > 0, '有新题时确实抽到新题');
  for (const s of a.strata.filter((x) => x.selected > 0)) {
    const inStratum = a.items.filter((q) => q.aspect === s.key);
    const n = inStratum.filter((q) => q.addedInVersion === '2026.12.1').length;
    assert.ok(n >= Math.min(Math.floor(s.selected * 0.3), 10), `${s.key} 至少取到配额`);
    assert.ok(n <= Math.floor(s.selected * 0.3), `${s.key} 新题不超过 30%`);
  }
  assert.equal(a.fresh.version, '2026.12.1');
  assert.equal(a.fresh.quota, freshCount);
  // 没有新版本：和不带新题偏好的抽样完全一致
  const none = pick({ freshVersion: null });
  const legacy = sampleBank('non_refusal', bank.map((q) => ({ ...q, addedInVersion: null })), { requested: 20, seed: 'seed-1' });
  assert.deepEqual(none.items.map((q) => q.id), legacy.items.map((q) => q.id));
  // 新版本在题库里没有题：同上
  const missing = pick({ freshVersion: '2099.01.1' });
  assert.deepEqual(missing.items.map((q) => q.id), none.items.map((q) => q.id));
  assert.equal(missing.fresh.quota, 0);
  // 换种子名单不同
  const other = sampleBank('non_refusal', bank, { requested: 20, seed: 'seed-2', freshVersion: '2026.12.1' });
  assert.notDeepEqual(other.items.map((q) => q.id), a.items.map((q) => q.id));
});

test('「立即更新」查重：定时任务预放的下次执行任务不算正在进行，只有同类手动任务才算', () => {
  const scheduled = { data: { kind: 'questions' as const, trigger: 'schedule' as const } };
  const manualKw = { data: { kind: 'keywords' as const, trigger: 'manual' as const, actorName: 'admin' } };
  const manualQ = { data: { kind: 'questions' as const, trigger: 'manual' as const, actorName: 'admin' } };
  assert.equal(hasPendingManualJob([scheduled], 'questions'), false, '只有定时任务的下次执行，不挡手动更新');
  assert.equal(hasPendingManualJob([scheduled, manualKw], 'questions'), false, '关键词的手动任务不挡题库更新');
  assert.equal(hasPendingManualJob([scheduled, manualQ], 'questions'), true);
  assert.equal(hasPendingManualJob([undefined], 'questions'), false);
});
