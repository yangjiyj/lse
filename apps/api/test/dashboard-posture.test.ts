import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { rateOverallRisk, scoreFromSeverityCounts } from '../src/lib/risk-rating.js';
import { buildSecurityScore } from '../src/modules/reports/scoring.js';
import {
  bjtDayKey,
  bjtDayStart,
  lastDayKeys,
  resolveRange,
} from '../src/modules/dashboard/posture-range.js';

const PREFIX = `__dashboard_posture_${randomUUID()}_`;
const H = 3600 * 1000;
const DAY = 24 * H;

let app!: FastifyInstance;
let token = '';
let noPermToken = '';
let userId = '';
let noPermUserId = '';
let roleId = '';
let noPermRoleId = '';
let targetId = '';
let taskId = '';
let baselineEmpty = false;
const findingIds: string[] = [];
const get = (url: string, t = token) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${t}` } });

interface Baseline {
  posture: { facts: { findingTotal: number; tasksInitiated: number } };
  changes: { newFindings: { current: number; previous: number } };
  trend: { points: Array<{ date: string; findings: number; high: number }> };
  cats: { items: Array<{ key: string; count: number }> };
}
let base!: Baseline;

async function snapshot(): Promise<Baseline> {
  return {
    posture: (await get('/api/dashboard/posture?range=7d')).json(),
    changes: (await get('/api/dashboard/changes?range=7d')).json(),
    trend: (await get('/api/dashboard/trend?days=30')).json(),
    cats: (await get('/api/dashboard/risk-categories?range=all&limit=20')).json(),
  };
}

async function mk(
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW',
  createdAt: Date,
  extra: {
    riskCategory?: string;
    reviewStatus?: 'UNREVIEWED' | 'FALSE_POSITIVE' | 'CONFIRMED';
  } = {},
) {
  const f = await prisma.finding.create({
    data: {
      taskId,
      engine: 'test',
      riskCategory: extra.riskCategory ?? 'prompt_injection',
      severity,
      reviewStatus: extra.reviewStatus ?? 'UNREVIEWED',
      createdAt,
    },
  });
  findingIds.push(f.id);
  return f;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.permission.upsert({
    where: { code: 'eval_task:read' },
    create: { code: 'eval_task:read', name: 'eval_task:read', group: '测试' },
    update: {},
  });
  const role = await prisma.role.create({
    data: {
      name: `${PREFIX}role`,
      permissions: { create: { permission: { connect: { code: 'eval_task:read' } } } },
    },
  });
  roleId = role.id;
  const user = await prisma.user.create({
    data: {
      username: PREFIX.slice(0, 60),
      passwordHash: 'test-only',
      displayName: 'posture',
      roles: { create: { roleId: role.id } },
    },
  });
  userId = user.id;
  token = app.jwt.sign({ sub: user.id, username: user.username });
  const noRole = await prisma.role.create({ data: { name: `${PREFIX}norole` } });
  noPermRoleId = noRole.id;
  const noUser = await prisma.user.create({
    data: {
      username: `${PREFIX}noperm`.slice(0, 64),
      passwordHash: 'test-only',
      displayName: 'noperm',
      roles: { create: { roleId: noRole.id } },
    },
  });
  noPermUserId = noUser.id;
  noPermToken = app.jwt.sign({ sub: noUser.id, username: noUser.username });

  const [f, t, a] = await Promise.all([
    prisma.finding.count(),
    prisma.evalTask.count(),
    prisma.auditLog.count({ where: { action: 'finding.review' } }),
  ]);
  baselineEmpty = f === 0 && t === 0 && a === 0;
  base = await snapshot();

  const target = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}target`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-only',
      model: 'm',
    },
  });
  targetId = target.id;
});

after(async () => {
  await prisma.auditLog.deleteMany({ where: { targetId: { in: findingIds } } });
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, noPermUserId] } } });
  await prisma.role.deleteMany({ where: { id: { in: [roleId, noPermRoleId] } } });
  await app.close();
  await prisma.$disconnect();
});

// ───────────────────────── 纯函数：共享规则 ─────────────────────────

test('共享规则：等级、样本偏少与评分门槛', () => {
  assert.equal(
    rateOverallRisk({ critical: 1, high: 0, medium: 0, low: 0, total: 50, valid: 50 }).level,
    'HIGH',
  );
  assert.equal(
    rateOverallRisk({ critical: 0, high: 5, medium: 0, low: 0, total: 50, valid: 50 }).level,
    'HIGH',
  );
  assert.equal(
    rateOverallRisk({ critical: 0, high: 4, medium: 0, low: 0, total: 50, valid: 50 }).level,
    'MEDIUM_HIGH',
  );
  assert.equal(
    rateOverallRisk({ critical: 0, high: 0, medium: 2, low: 0, total: 50, valid: 50 }).level,
    'MEDIUM',
  );
  assert.equal(
    rateOverallRisk({ critical: 0, high: 0, medium: 0, low: 3, total: 50, valid: 50 }).level,
    'LOW',
  );
  const unrated = rateOverallRisk({
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    total: 50,
    valid: 20,
  });
  assert.equal(unrated.level, 'UNRATED');
  assert.equal(unrated.score, null);
  const few = rateOverallRisk({ critical: 0, high: 1, medium: 0, low: 0, total: 8, valid: 8 });
  assert.equal(few.level, 'MEDIUM_HIGH');
  assert.equal(few.fewValid, true);
  assert.equal(few.score, null);
  assert.equal(
    rateOverallRisk({ critical: 0, high: 1, medium: 0, low: 0, total: 50, valid: 50 }).score,
    80,
  );
});

test('按计数算分与报告 buildSecurityScore 一致', () => {
  const sevs = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
  for (const counts of [
    { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4, INFO: 5 },
    { CRITICAL: 9, HIGH: 9, MEDIUM: 9, LOW: 9, INFO: 9 },
  ]) {
    const findings = sevs.flatMap((s) =>
      Array.from({ length: counts[s] }, () => ({ severity: s })),
    );
    assert.equal(
      scoreFromSeverityCounts(counts, 2),
      buildSecurityScore({ findings, engineRuns: [{ status: 'SKIPPED' }, { status: 'SKIPPED' }] })
        .score,
    );
  }
});

test('时间窗：北京时间自然日、上期等长且不越界', () => {
  assert.equal(bjtDayKey(new Date('2026-10-21T16:30:00Z')), '2026-10-22'); // UTC 16:30 = 北京次日 00:30
  assert.equal(bjtDayKey(new Date('2026-10-21T15:30:00Z')), '2026-10-21');
  const now = new Date('2026-10-22T05:00:00Z'); // 北京 13:00
  const m = resolveRange('month', now);
  assert.equal(m.current.start!.toISOString(), '2026-09-30T16:00:00.000Z'); // 10-01 00:00 北京
  assert.equal(m.previous!.start!.toISOString(), '2026-08-31T16:00:00.000Z');
  assert.equal(
    m.previous!.end.getTime() - m.previous!.start!.getTime(),
    now.getTime() - m.current.start!.getTime(),
  );
  const s = resolveRange('7d', now);
  assert.equal(s.previous!.end.getTime(), s.current.start!.getTime());
  assert.equal(resolveRange('all', now).previous, null);
  // 月初第 1 天：上期窗口不会越过本月 1 日
  const early = resolveRange('month', new Date('2026-03-01T01:00:00Z'));
  assert.ok(early.previous!.end.getTime() <= early.current.start!.getTime());
  const { keys } = lastDayKeys(3, new Date('2026-10-21T16:30:00Z'));
  assert.deepEqual(keys, ['2026-10-20', '2026-10-21', '2026-10-22']);
});

// ───────────────────────── 权限 ─────────────────────────

test('四个接口：未登录 401，无 eval_task:read 403', async () => {
  for (const url of [
    '/api/dashboard/posture',
    '/api/dashboard/trend',
    '/api/dashboard/risk-categories',
    '/api/dashboard/changes',
  ]) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
    assert.equal((await get(url, noPermToken)).statusCode, 403, url);
    assert.equal((await get(url)).statusCode, 200, url);
  }
});

test('参数校验：非法 range / days / limit 返回 400', async () => {
  assert.equal((await get('/api/dashboard/posture?range=year')).statusCode, 400);
  assert.equal((await get('/api/dashboard/trend?days=0')).statusCode, 400);
  assert.equal((await get('/api/dashboard/trend?days=91')).statusCode, 400);
  assert.equal((await get('/api/dashboard/risk-categories?limit=0')).statusCode, 400);
});

// ───────────────────────── 空库 ─────────────────────────

test('空库：暂无法评级、评分 null、趋势补零、类别为空、复核时长 null 并说明原因', async (t) => {
  if (!baselineEmpty) return t.skip('测试库非空，空库断言跳过（由其他断言覆盖）');
  const p = base.posture as unknown as Record<string, unknown> & { facts: Record<string, number> };
  assert.equal(p.riskLevel, 'UNRATED');
  assert.equal(p.score, null);
  assert.equal(p.facts.findingTotal, 0);
  assert.equal(base.trend.points.length, 30);
  assert.ok(base.trend.points.every((x) => x.findings === 0 && x.high === 0));
  assert.deepEqual(base.cats.items, []);
  const c = (await get('/api/dashboard/changes?range=month')).json();
  assert.equal(c.avgReviewHours.current, null);
  assert.ok(c.avgReviewHours.unavailableReason);
  assert.equal(c.highShare.current, null);
  assert.equal(c.newFindings.current, 0);
});

// ───────────────────────── 有数据 / 多状态 / 跨周期 / 时区 ─────────────────────────

test('有数据：趋势按北京时间分日、误报不计、类别中文名与严重度分布', async () => {
  const now = Date.now();
  const todayStart = bjtDayStart(bjtDayKey(new Date(now))).getTime();
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}task`,
      modelTargetId: targetId,
      engines: [],
      dimensions: [],
      status: 'COMPLETED',
      totalQuestions: 40,
      passedCount: 30,
      failedCount: 10,
    },
  });
  taskId = task.id;
  const dMinus2 = bjtDayKey(new Date(todayStart - 2 * DAY + 12 * H));
  const dMinus1 = bjtDayKey(new Date(todayStart - DAY + 12 * H));
  // 北京 D-2 23:30（UTC D-2 15:30）→ 归 D-2；北京 D-1 00:30（UTC 仍是 D-2 16:30）→ 必须归 D-1
  await mk('HIGH', new Date(todayStart - 2 * DAY + 23.5 * H));
  await mk('CRITICAL', new Date(todayStart - DAY + 0.5 * H));
  await mk('MEDIUM', new Date(todayStart - DAY + 1 * H), { riskCategory: 'privacy_leakage' });
  await mk('HIGH', new Date(todayStart - DAY + 2 * H), { reviewStatus: 'FALSE_POSITIVE' }); // 误报不计
  const trend = (await get('/api/dashboard/trend?days=30')).json() as Baseline['trend'];
  const day = (r: Baseline['trend'], d: string) => r.points.find((x) => x.date === d)!;
  assert.equal(trend.points.length, 30);
  assert.equal(trend.points.at(-1)!.date, bjtDayKey(new Date(now)));
  assert.equal(day(trend, dMinus2).findings - day(base.trend, dMinus2).findings, 1);
  assert.equal(day(trend, dMinus2).high - day(base.trend, dMinus2).high, 1);
  assert.equal(day(trend, dMinus1).findings - day(base.trend, dMinus1).findings, 2);
  assert.equal(day(trend, dMinus1).high - day(base.trend, dMinus1).high, 1);

  const cats = (await get('/api/dashboard/risk-categories?range=all&limit=20')).json() as {
    items: Array<{
      key: string;
      label: string;
      count: number;
      high: number;
      severity: Record<string, number>;
    }>;
  };
  const get1 = (r: typeof cats | Baseline['cats'], k: string) =>
    (r.items as Array<{ key: string; count: number }>).find((i) => i.key === k)?.count ?? 0;
  assert.equal(get1(cats, 'prompt_injection') - get1(base.cats, 'prompt_injection'), 2);
  assert.equal(get1(cats, 'privacy_leakage') - get1(base.cats, 'privacy_leakage'), 1);
  const pi = cats.items.find((i) => i.key === 'prompt_injection')!;
  assert.equal(pi.label, '提示词注入/越狱风险');
  assert.ok(pi.high >= 2 && pi.severity.CRITICAL >= 1);
  const top1 = (await get('/api/dashboard/risk-categories?range=all&limit=1')).json();
  assert.equal(top1.items.length, 1);
});

test('跨周期：近 7 天较上一个 7 天的变化与高危占比', async () => {
  const now = Date.now();
  // 本期（近 7 天）：1 高危 + 1 低危；上期（7–14 天前）：1 高危
  await mk('HIGH', new Date(now - 2 * DAY), { riskCategory: 'data_exfiltration' });
  await mk('LOW', new Date(now - 3 * DAY), { riskCategory: 'data_exfiltration' });
  await mk('HIGH', new Date(now - 10 * DAY), { riskCategory: 'data_exfiltration' });
  const c = (await get('/api/dashboard/changes?range=7d')).json();
  // 本期新增 = 上一用例留下的 3 条（D-2、D-1，不含误报）+ 本用例 2 条
  assert.equal(c.newFindings.current - base.changes.newFindings.current, 5);
  assert.equal(c.newFindings.previous - base.changes.newFindings.previous, 1);
  assert.equal(c.newFindings.delta, c.newFindings.current - c.newFindings.previous);
  if (baselineEmpty) {
    assert.equal(c.highShare.current, 0.6); // 3 高危 / 5
    assert.equal(c.highShare.previous, 1);
    assert.equal(c.highShare.delta, -0.4);
  }
  const all = (await get('/api/dashboard/changes?range=all')).json();
  assert.equal(all.previous, null);
  assert.equal(all.newFindings.previous, null);
  assert.equal(all.newFindings.delta, null);
  assert.ok(all.previousUnavailableReason);
});

test('平均复核时长：取审计日志中首次最终结论，待复核/未复核不计', async () => {
  const now = Date.now();
  const created = new Date(now - 2 * DAY);
  const f1 = await mk('HIGH', created, { riskCategory: 'cyber_abuse' });
  const f2 = await mk('HIGH', created, { riskCategory: 'cyber_abuse' });
  await mk('HIGH', created, { riskCategory: 'cyber_abuse' }); // 无复核记录
  const ev = (fid: string, status: string, afterH: number) =>
    prisma.auditLog.create({
      data: {
        action: 'finding.review',
        targetType: 'finding',
        targetId: fid,
        detail: { reviewStatus: status },
        createdAt: new Date(created.getTime() + afterH * H),
      },
    });
  await ev(f1.id, 'NEEDS_REVIEW', 1); // 非最终结论
  await ev(f1.id, 'CONFIRMED', 4); // 首次最终结论：4h
  await ev(f1.id, 'FALSE_POSITIVE', 30); // 之后再改，不重复计
  await ev(f2.id, 'ACCEPTED_RISK', 8); // 8h
  const c = (await get('/api/dashboard/changes?range=7d')).json();
  assert.equal(c.avgReviewHours.unavailableReason, null);
  if (baselineEmpty) {
    assert.equal(c.avgReviewHours.current, 6); // (4 + 8) / 2
    assert.equal(c.avgReviewHours.sampleSize.current, 2);
    assert.equal(c.avgReviewHours.previous, null); // 上期无复核记录
  } else {
    assert.ok(c.avgReviewHours.current > 0);
  }
});

test('态势：事实口径与评级（与报告同一规则）', async () => {
  const p = (await get('/api/dashboard/posture?range=7d')).json();
  assert.equal(p.facts.tasksInitiated - base.posture.facts.tasksInitiated, 1);
  // 全部风险回复含误报；有效回复不含
  assert.equal(p.facts.findingTotal - p.facts.activeFindingTotal, p.facts.falsePositiveExcluded);
  assert.ok(p.facts.falsePositiveExcluded >= 1);
  assert.ok(['HIGH', 'MEDIUM_HIGH', 'MEDIUM', 'LOW', 'UNRATED'].includes(p.riskLevel));
  if (baselineEmpty) {
    // 按任务口径统计本任务全部有效回复：严重 1、高危 6（含 10 天前那条）、中危 1、低危 1；复核用例后 f1 被改判误报
    assert.equal(p.riskLevel, 'HIGH');
    assert.match(p.levelBasis, /严重风险/);
    assert.equal(p.facts.testItems, 40);
    assert.equal(p.facts.validJudgements, 40);
    assert.equal(p.score, scoreFromSeverityCounts(p.severityCounts));
  }
});

test('态势：本月 / 全部范围均可返回', async () => {
  for (const range of ['month', 'all']) {
    const r = await get(`/api/dashboard/posture?range=${range}`);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().range, range);
  }
});
