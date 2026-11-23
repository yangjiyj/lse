import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';
import { prisma } from '../src/db.js';
import { buildFrameworkCoverage, SAMPLE_ADEQUATE_MIN } from '../src/modules/frameworks/coverage.js';

const PREFIX = '__framework_coverage_';
const USERNAME = `${PREFIX}forbidden`;
const PASSWORD = `${PREFIX}password`;
const ADMIN_PASSWORD = ['Admin', '@', '12345'].join('');
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
let forbiddenToken = '';
let task1 = '';
let target1 = '';
let target2 = '';

const group = (domains: string[], passed: number, failed = 0, undetermined = 0) => ({
  domains,
  passed,
  failed,
  undetermined,
});
const rowOf = (
  rows: ReturnType<typeof buildFrameworkCoverage>['rows'],
  framework: string,
  id: string,
) => {
  const row = rows.find((item) => item.framework === framework && item.entryId === id);
  assert.ok(row, `缺少条目 ${framework}:${id}`);
  return row;
};

async function cleanup() {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.role.deleteMany({ where: { name: `${PREFIX}role` } });
  await prisma.user.deleteMany({ where: { username: USERNAME } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const role = await prisma.role.create({
    data: { name: `${PREFIX}role`, description: '无评测权限测试角色' },
  });
  await prisma.user.create({
    data: {
      username: USERNAME,
      passwordHash: await hashPassword(PASSWORD),
      displayName: '覆盖矩阵权限测试用户',
      passwordChangedAt: new Date(),
      lastActiveAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });
  const adminLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ADMIN_PASSWORD },
  });
  adminToken = adminLogin.json().token;
  const forbiddenLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: USERNAME, password: PASSWORD },
  });
  forbiddenToken = forbiddenLogin.json().token;

  const mk = (name: string) =>
    prisma.modelTarget.create({
      data: {
        name: `${PREFIX}${name}`,
        provider: 'test',
        baseUrl: 'https://placeholder.invalid',
        apiKey: '',
        model: 'test',
      },
    });
  target1 = (await mk('t1')).id;
  target2 = (await mk('t2')).id;
  const set = await prisma.questionSet.create({
    data: { name: `${PREFIX}set`, type: 'GENERAL', tags: [] },
  });
  const question = (key: string, category: string) =>
    prisma.question.create({
      data: {
        questionSetId: set.id,
        content: `${PREFIX}${key}`,
        category,
        type: 'GENERAL',
        tags: [],
      },
    });
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}task1`,
      status: 'COMPLETED',
      modelTargetId: target1,
      questionSets: { create: { questionSetId: set.id } },
    },
  });
  task1 = task.id;
  const add = async (
    taskId: string,
    targetId: string,
    key: string,
    category: string,
    verdict: 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR',
  ) => {
    const q = await question(key, category);
    await prisma.evalResult.create({
      data: {
        taskId,
        questionId: q.id,
        modelTargetId: targetId,
        prompt: 'p',
        response: 'r',
        finalVerdict: verdict,
      },
    });
  };
  for (let i = 0; i < 11; i += 1) await add(task1, target1, `pi${i}`, 'prompt_injection', 'PASS');
  await add(task1, target1, 'pi_fail', 'prompt_injection', 'FAIL');
  await add(task1, target1, 'gs', 'general_safety', 'PASS');
  await add(task1, target1, 'pl', 'privacy_leakage', 'UNKNOWN');
  await add(task1, target1, 'err', 'prompt_injection', 'ERROR');
  const old = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}task2`,
      status: 'COMPLETED',
      modelTargetId: target2,
      createdAt: new Date(Date.now() - 100 * 86400_000),
      questionSets: { create: { questionSetId: set.id } },
    },
  });
  await add(old.id, target2, 'spl', 'system_prompt_leakage', 'PASS');
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('状态规则：未测试 / 已测无风险 / 已测有风险 / 平台暂不覆盖', () => {
  const { rows } = buildFrameworkCoverage({
    groups: [group(['prompt_injection'], 9, 1), group(['privacy_leakage'], 3)],
  });
  const llm01 = rowOf(rows, 'OWASP_LLM', 'LLM01');
  assert.deepEqual(
    [llm01.tested, llm01.passed, llm01.failed, llm01.status],
    [10, 9, 1, 'TESTED_FINDINGS'],
  );
  assert.equal(rowOf(rows, 'OWASP_LLM', 'LLM02').status, 'TESTED_CLEAN');
  assert.equal(rowOf(rows, 'OWASP_LLM', 'LLM05').status, 'NOT_TESTED');
  const asi04 = rowOf(rows, 'OWASP_AGENTIC', 'ASI04');
  assert.equal(asi04.status, 'NOT_SUPPORTED');
  // ASI04 不再写“平台暂不覆盖”，改指向 AI 组件漏洞扫描（状态枚举不新增，只改说明）
  assert.doesNotMatch(asi04.note ?? '', /平台暂不覆盖/);
  assert.match(asi04.note ?? '', /部分覆盖/);
  assert.match(asi04.note ?? '', /AI 组件漏洞扫描/);
  // 其余不支持条目仍保持原有说明
  assert.match(rowOf(rows, 'OWASP_AGENTIC', 'ASI07').note ?? '', /平台暂不覆盖/);
  assert.equal(rowOf(rows, 'OWASP_AGENTIC', 'ASI10').tested, 0);
});

test('undetermined 不计为通过，且单独有无法判定时不报风险', () => {
  const { rows } = buildFrameworkCoverage({ groups: [group(['privacy_leakage'], 0, 0, 4)] });
  const row = rowOf(rows, 'GBT45654_ANNEX_A', 'A.4');
  assert.deepEqual(
    [row.passed, row.undetermined, row.tested, row.status],
    [0, 4, 4, 'TESTED_CLEAN'],
  );
});

test('小样本：tested >= 10 才算样本充足', () => {
  const small = buildFrameworkCoverage({
    groups: [group(['prompt_injection'], SAMPLE_ADEQUATE_MIN - 1)],
  });
  assert.equal(rowOf(small.rows, 'OWASP_LLM', 'LLM01').sampleAdequate, false);
  const enough = buildFrameworkCoverage({
    groups: [group(['prompt_injection'], SAMPLE_ADEQUATE_MIN)],
  });
  assert.equal(rowOf(enough.rows, 'OWASP_LLM', 'LLM01').sampleAdequate, true);
});

test('多映射：一个风险域映射多个条目时各计一次，同一结果不会在同一条目重复计', () => {
  // data_exfiltration → LLM02 + LLM06 + ASI02 + ATLAS T0086；智能体外发不是生成内容风险，不映射附录 A.4
  const one = buildFrameworkCoverage({ groups: [group(['data_exfiltration'], 2)] });
  assert.equal(rowOf(one.rows, 'GBT45654_ANNEX_A', 'A.4').tested, 0);
  for (const [framework, id] of [
    ['OWASP_LLM', 'LLM02'],
    ['OWASP_LLM', 'LLM06'],
    ['OWASP_AGENTIC', 'ASI02'],
    ['ATLAS', 'AML.T0086'],
  ] as const) {
    assert.equal(rowOf(one.rows, framework, id).tested, 2, `${framework}:${id}`);
  }
  assert.equal(one.summary.totalTested, 2);
  // 同一结果同时落在 data_exfiltration 与 privacy_leakage 两个域，都映射 LLM02：只计 1 次。
  const both = buildFrameworkCoverage({
    groups: [group(['data_exfiltration', 'privacy_leakage'], 1)],
  });
  assert.equal(rowOf(both.rows, 'OWASP_LLM', 'LLM02').tested, 1);
});

test('平台应用评估场景经既有映射补充 ASI01，未映射结果单独汇总', () => {
  const { rows, summary } = buildFrameworkCoverage({
    groups: [
      {
        domains: ['prompt_injection'],
        appScenarios: ['indirect_url'],
        passed: 3,
        failed: 0,
        undetermined: 0,
      },
      group(['general_safety'], 5),
    ],
  });
  assert.equal(rowOf(rows, 'OWASP_AGENTIC', 'ASI01').tested, 3);
  assert.equal(summary.unmappedTested, 5);
  assert.equal(summary.totalTested, 8);
});

test('NOT_SUPPORTED 清单由映射表反推：智能体 ASI04/07/09/10 暂不覆盖（ASI08 已由沙箱 L8 级联故障场景覆盖），其余三个框架无', () => {
  const { rows } = buildFrameworkCoverage({ groups: [] });
  const unsupported = rows
    .filter((row) => row.status === 'NOT_SUPPORTED')
    .map((row) => `${row.framework}:${row.entryId}`);
  assert.deepEqual(unsupported, [
    'OWASP_AGENTIC:ASI04',
    'OWASP_AGENTIC:ASI07',
    'OWASP_AGENTIC:ASI09',
    'OWASP_AGENTIC:ASI10',
  ]);
  assert.ok(
    rows.filter((row) => row.framework === 'ATLAS').length < 20,
    'ATLAS 只展示平台可映射的技术',
  );
});

test('framework 过滤只返回对应框架，汇总的未映射数相对于该框架', () => {
  const { rows, summary } = buildFrameworkCoverage({
    groups: [group(['prompt_injection'], 2)],
    frameworks: ['GBT45654_ANNEX_A'],
  });
  assert.ok(rows.every((row) => row.framework === 'GBT45654_ANNEX_A'));
  assert.equal(summary.unmappedTested, 2, 'prompt_injection 不映射任何国标附录 A 条款');
});

test('覆盖矩阵路由需要登录与任务读取权限', async () => {
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/frameworks/coverage' })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/frameworks/coverage',
        headers: auth(forbiddenToken),
      })
    ).statusCode,
    403,
  );
});

test('路由按评估对象过滤，并只统计已判定结果（ERROR 不计）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/frameworks/coverage?targetId=${target1}`,
    headers: auth(adminToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  const llm01 = rowOf(body.rows, 'OWASP_LLM', 'LLM01');
  assert.deepEqual(
    [llm01.tested, llm01.passed, llm01.failed, llm01.status, llm01.sampleAdequate],
    [12, 11, 1, 'TESTED_FINDINGS', true],
  );
  assert.deepEqual(
    llm01.recentTasks.map((t: { id: string }) => t.id),
    [task1],
  );
  assert.equal(rowOf(body.rows, 'OWASP_LLM', 'LLM02').undetermined, 1);
  assert.equal(body.summary.totalTested, 14);
  assert.equal(body.summary.unmappedTested, 1);
});

test('路由按单个任务、时间窗与框架过滤', async () => {
  const byTask = (
    await app.inject({
      method: 'GET',
      url: `/api/frameworks/coverage?taskId=${task1}&framework=ATLAS`,
      headers: auth(adminToken),
    })
  ).json();
  assert.ok(byTask.rows.every((row: { framework: string }) => row.framework === 'ATLAS'));
  assert.equal(rowOf(byTask.rows, 'ATLAS', 'AML.T0051').tested, 12);
  const recent = (
    await app.inject({
      method: 'GET',
      url: `/api/frameworks/coverage?targetId=${target2}&days=30`,
      headers: auth(adminToken),
    })
  ).json();
  assert.equal(recent.summary.totalTested, 0);
  const wide = (
    await app.inject({
      method: 'GET',
      url: `/api/frameworks/coverage?targetId=${target2}&days=365`,
      headers: auth(adminToken),
    })
  ).json();
  assert.equal(rowOf(wide.rows, 'OWASP_LLM', 'LLM07').tested, 1);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/frameworks/coverage?framework=BAD',
        headers: auth(adminToken),
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/frameworks/coverage?taskId=00000000-0000-4000-8000-000000000000',
        headers: auth(adminToken),
      })
    ).statusCode,
    404,
  );
});
