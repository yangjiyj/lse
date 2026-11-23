import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { generateApiToken } from '../src/plugins/api-token-auth.js';
import {
  SUMMARY_MAX_CHARS,
  buildJunit,
  buildSarif,
  safeSummary,
  xmlEscape,
  type ExportBundle,
} from '../src/modules/ci-export/format.js';

const PREFIX = '__ci_export_test_';
// 构造的假密钥，仅用于验证脱敏
const FAKE_SECRET = 'sk-abcdef1234567890abcdef'; // pragma: allowlist secret

let app: Awaited<ReturnType<typeof buildApp>>;
let adminJwt = '';
let taskId = '';
let emptyTaskId = '';
let targetId = '';
let gateId = '';
const tokenIds: string[] = [];

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** 极简 XML 良构检查：标签配对、属性值/文本中不得有未转义的 < &。 */
function assertWellFormedXml(xml: string): void {
  const stack: string[] = [];
  const re =
    /<\?xml[^>]*\?>|<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w.-]+="(?:[^"<&]|&(?:amp|lt|gt|quot|apos);)*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(xml))) {
    consumed += m[0].length;
    if (m[5] !== undefined) {
      assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(m[5]), `文本含未转义 &：${m[5]}`);
      continue;
    }
    if (!m[2]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `标签不配对：${m[2]}`);
    else if (!m[4]) stack.push(m[2]);
  }
  assert.equal(consumed, xml.length, 'XML 含无法解析的片段');
  assert.equal(stack.length, 0, '存在未闭合标签');
}

async function makeToken(scopes: string[]): Promise<string> {
  const { token, prefix, tokenHash } = generateApiToken();
  const row = await prisma.apiToken.create({
    data: {
      name: `${PREFIX}tok${tokenIds.length}`,
      prefix,
      tokenHash,
      scopes,
      expiresAt: new Date(Date.now() + 86400_000),
    },
  });
  tokenIds.push(row.id);
  return token;
}

async function cleanup(): Promise<void> {
  const tasks = await prisma.evalTask.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  await prisma.auditLog.deleteMany({
    where: { targetId: { in: [...tasks.map((t) => t.id), ...tokenIds] } },
  });
  await prisma.gateRule.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  adminJwt = login.json().token;
  targetId = (
    await prisma.modelTarget.create({
      data: {
        name: `${PREFIX}target`,
        provider: 'openai-compatible',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'dummy', // pragma: allowlist secret
        model: 'm',
      },
    })
  ).id;
  const set = await prisma.questionSet.create({
    data: {
      name: `${PREFIX}set`,
      questions: {
        create: [
          { content: `${PREFIX}q1 <b>&`, category: '隐私泄露', type: 'COMPLIANCE' },
          { content: `${PREFIX}q2`, category: '隐私泄露', type: 'COMPLIANCE' },
          { content: `${PREFIX}q3`, category: '违法内容', type: 'COMPLIANCE' },
          { content: `${PREFIX}q4`, category: '违法内容', type: 'COMPLIANCE' },
        ],
      },
    },
    include: { questions: { orderBy: { content: 'asc' } } },
  });
  const qs = set.questions;
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}task`,
      status: 'COMPLETED',
      modelTargetId: targetId,
      totalQuestions: 4,
      passedCount: 1,
      failedCount: 2,
      finishedAt: new Date(),
    },
  });
  taskId = task.id;
  const verdicts = ['FAIL', 'PASS', 'FAIL', null] as const;
  for (let i = 0; i < 4; i++) {
    const r = await prisma.evalResult.create({
      data: {
        taskId,
        questionId: qs[i]!.id,
        modelTargetId: targetId,
        prompt: 'p',
        // 完整有害回答：绝不能出现在任何导出里
        response: 'FULL-HARMFUL-RESPONSE-SHOULD-NOT-LEAK',
        finalVerdict: verdicts[i] ?? undefined,
      },
    });
    if (verdicts[i] === 'FAIL') {
      const f = await prisma.finding.create({
        data: {
          taskId,
          resultId: r.id,
          questionId: qs[i]!.id,
          engine: 'test',
          riskCategory: i === 0 ? '隐私泄露' : '违法内容',
          severity: i === 0 ? 'HIGH' : 'MEDIUM',
          verdict: 'FAIL',
          title: '泄露了凭据',
          evidence: `模型输出了 ${FAKE_SECRET} ` + '长'.repeat(500),
        },
      });
      if (i === 0) {
        await prisma.findingFrameworkMapping.create({
          data: {
            findingId: f.id,
            framework: 'OWASP_LLM',
            entryId: 'LLM02',
            entryName: '敏感信息泄露',
            reason: 't',
          },
        });
      }
    }
  }
  emptyTaskId = (
    await prisma.evalTask.create({
      data: { name: `${PREFIX}empty`, status: 'COMPLETED', modelTargetId: targetId },
    })
  ).id;
  const gate = await prisma.gateRule.create({
    data: { name: `${PREFIX}gate`, modelTargetId: targetId, rules: { minScore: 90 } },
  });
  gateId = gate.id;
  await prisma.gateEvaluation.create({
    data: { gateId, taskId, passed: false, reasons: ['总体得分低于门槛'], metrics: { score: 50 } },
  });
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('纯函数：safeSummary 脱敏并截断到 300 字', () => {
  const s = safeSummary(`key ${FAKE_SECRET} ` + 'x'.repeat(1000));
  assert.ok(!s.includes(FAKE_SECRET));
  assert.ok(Array.from(s).length <= SUMMARY_MAX_CHARS + 1);
  assert.ok(s.endsWith('…'));
  assert.equal(safeSummary(null), '');
});

test('纯函数：xmlEscape 处理特殊字符与控制字符', () => {
  assert.equal(xmlEscape('a<b>&"\'\u0001'), 'a&lt;b&gt;&amp;&quot;&apos;');
});

test('纯函数：JUnit/SARIF 结构（含未判定 skipped 与出错 error）', () => {
  const bundle: ExportBundle = {
    generatedAt: new Date().toISOString(),
    task: {
      id: 't1',
      name: '任务 <x>',
      status: 'COMPLETED',
      modelTargetName: null,
      startedAt: null,
      finishedAt: null,
      totalQuestions: 3,
      passedCount: 0,
      failedCount: 1,
      errorCount: 1,
    },
    gates: [],
    cases: [
      {
        resultId: 'r1',
        questionId: 'q1xxxxxxxx',
        category: 'A',
        title: 't',
        verdict: 'FAIL',
        severity: 'CRITICAL',
        summary: '坏 & 事',
        engines: [],
        frameworks: [{ framework: 'ATLAS', entryId: 'AML.T0051', entryName: 'x' }],
        latencyMs: 1500,
      },
      {
        resultId: 'r2',
        questionId: 'q2xxxxxxxx',
        category: 'A',
        title: 't',
        verdict: 'UNKNOWN',
        severity: null,
        summary: '',
        engines: [],
        frameworks: [],
        latencyMs: null,
      },
      {
        resultId: 'r3',
        questionId: 'q3xxxxxxxx',
        category: 'B',
        title: 't',
        verdict: 'ERROR',
        severity: null,
        summary: '超时',
        engines: [],
        frameworks: [],
        latencyMs: null,
      },
    ],
  };
  const xml = buildJunit(bundle);
  assertWellFormedXml(xml);
  assert.match(xml, /<testsuite name="A" tests="2" failures="1" errors="0" skipped="1"/);
  assert.match(xml, /<skipped message="未判定/);
  assert.match(xml, /<error message="超时"/);
  const sarif = buildSarif(bundle) as {
    version: string;
    runs: Array<{ results: Array<Record<string, any>> }>;
  };
  assert.equal(sarif.version, '2.1.0');
  const res = sarif.runs[0]!.results;
  assert.equal(res.length, 1);
  assert.equal(res[0]!.level, 'error');
  assert.equal(res[0]!.ruleId, 'A');
  assert.equal(res[0]!.properties.atlas[0].entryId, 'AML.T0051');
});

test('导出 JSON：任务摘要、门禁结果、发现列表；不含完整回答；密钥已脱敏', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${taskId}/export?format=json`,
    headers: bearer(adminJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /application\/json/);
  const body = res.json();
  assert.equal(body.task.id, taskId);
  assert.equal(body.gate.passed, false);
  assert.equal(body.gate.items[0].gateName, `${PREFIX}gate`);
  assert.equal(body.findings.length, 2);
  assert.ok(!res.body.includes('FULL-HARMFUL-RESPONSE-SHOULD-NOT-LEAK'));
  assert.ok(!res.body.includes(FAKE_SECRET));
  for (const f of body.findings) assert.ok(Array.from(f.summary as string).length <= 301);
});

test('导出 JUnit：可解析，每类别一个 suite，失败题含 failure，未判定为 skipped', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${taskId}/export?format=junit`,
    headers: bearer(adminJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  assertWellFormedXml(res.body);
  assert.equal((res.body.match(/<testsuite /g) ?? []).length, 2);
  assert.equal((res.body.match(/<failure /g) ?? []).length, 2);
  assert.equal((res.body.match(/<skipped /g) ?? []).length, 1);
  assert.ok(!res.body.includes('FULL-HARMFUL-RESPONSE-SHOULD-NOT-LEAK'));
  assert.ok(!res.body.includes(FAKE_SECRET));
});

test('导出 SARIF：必要字段与 OWASP 映射', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${taskId}/export?format=sarif`,
    headers: bearer(adminJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  const s = res.json();
  assert.equal(s.version, '2.1.0');
  assert.ok(s.$schema);
  assert.equal(s.runs[0].tool.driver.rules.length, 2);
  const results = s.runs[0].results;
  assert.equal(results.length, 2);
  const high = results.find((r: any) => r.ruleId === '隐私泄露');
  assert.equal(high.level, 'error');
  assert.equal(high.properties.taskId, taskId);
  assert.ok(high.properties.questionId);
  assert.equal(high.properties.owasp[0].entryId, 'LLM02');
  assert.equal(results.find((r: any) => r.ruleId === '违法内容').level, 'warning');
});

test('空任务三种格式都可导出', async () => {
  for (const format of ['junit', 'sarif', 'json']) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/eval-tasks/${emptyTaskId}/export?format=${format}`,
      headers: bearer(adminJwt),
    });
    assert.equal(res.statusCode, 200, `${format}: ${res.body}`);
  }
});

test('权限与错误：未登录 401；令牌范围不足 403；任务不存在 404；非法格式 400', async () => {
  const url = `/api/eval-tasks/${taskId}/export?format=json`;
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  const wrong = await makeToken(['gates:read']);
  assert.equal((await app.inject({ method: 'GET', url, headers: bearer(wrong) })).statusCode, 403);
  const missing = await app.inject({
    method: 'GET',
    url: '/api/eval-tasks/00000000-0000-4000-8000-000000000000/export',
    headers: bearer(adminJwt),
  });
  assert.equal(missing.statusCode, 404);
  const bad = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${taskId}/export?format=csv`,
    headers: bearer(adminJwt),
  });
  assert.equal(bad.statusCode, 400);
});

test('API 令牌（eval-tasks:read）可导出，并写 eval_task.export 审计', async () => {
  const tok = await makeToken(['eval-tasks:read']);
  const res = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${taskId}/export?format=sarif`,
    headers: bearer(tok),
  });
  assert.equal(res.statusCode, 200, res.body);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'eval_task.export', targetId: taskId },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit);
  assert.match(String(audit.actorName), /API 令牌/);
  assert.ok(!JSON.stringify(audit.detail).includes(tok));
});

test('按任务查门禁判定：令牌 gates:read 可用；未知任务 404；无门禁判定 evaluated=false', async () => {
  const tok = await makeToken(['gates:read']);
  const ok = await app.inject({
    method: 'GET',
    url: `/api/gates/evaluations/by-task/${taskId}`,
    headers: bearer(tok),
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const j = ok.json();
  assert.equal(j.taskStatus, 'COMPLETED');
  assert.equal(j.evaluated, true);
  assert.equal(j.passed, false);
  assert.equal(j.items[0].gateId, gateId);
  const none = await app.inject({
    method: 'GET',
    url: `/api/gates/evaluations/by-task/${emptyTaskId}`,
    headers: bearer(tok),
  });
  assert.equal(none.json().evaluated, false);
  assert.equal(none.json().passed, null);
  const nf = await app.inject({
    method: 'GET',
    url: '/api/gates/evaluations/by-task/00000000-0000-4000-8000-000000000000',
    headers: bearer(tok),
  });
  assert.equal(nf.statusCode, 404);
  const noscope = await makeToken(['eval-tasks:read']);
  const forb = await app.inject({
    method: 'GET',
    url: `/api/gates/evaluations/by-task/${taskId}`,
    headers: bearer(noscope),
  });
  assert.equal(forb.statusCode, 403);
});
