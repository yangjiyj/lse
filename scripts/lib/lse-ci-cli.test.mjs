// 端到端：用本地假服务驱动 lse-ci.mjs，校验退出码与不泄露令牌。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lse-ci.mjs');
const TOKEN = 'lse_0123abcd_' + 'b'.repeat(32);
const T_OK = '11111111-1111-4111-8111-111111111111';
const T_FAIL = '22222222-2222-4222-8222-222222222222';
const T_ERR = '33333333-3333-4333-8333-333333333333';

let server;
let url;

const gateResp = (taskId, taskStatus, passed) => ({
  taskId,
  taskStatus,
  totalQuestions: 2,
  processedQuestions: 2,
  passedCount: 1,
  failedCount: 1,
  errorCount: 0,
  evaluated: passed !== null,
  passed,
  items:
    passed === null
      ? []
      : [{ gateId: 'g', gateName: '发布门禁', passed, reasons: passed ? [] : ['得分过低'] }],
});

before(async () => {
  server = http.createServer((req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: '无效' });
    const m = /^\/api\/gates\/evaluations\/by-task\/(.+)$/.exec(req.url);
    if (m) {
      if (m[1] === T_OK) return send(200, gateResp(T_OK, 'COMPLETED', true));
      if (m[1] === T_FAIL) return send(200, gateResp(T_FAIL, 'COMPLETED', false));
      if (m[1] === T_ERR) return send(200, gateResp(T_ERR, 'FAILED', null));
      return send(404, { message: '评估任务不存在' });
    }
    if (req.method === 'POST' && req.url === '/api/eval-plans/plan-ok/trigger')
      return send(200, { status: 'triggered', taskId: T_OK });
    if (req.method === 'POST' && req.url === '/api/eval-plans/plan-skip/trigger')
      return send(409, { status: 'skipped', reason: '间隔不足' });
    if (req.url.startsWith(`/api/eval-tasks/${T_OK}/export`))
      return send(200, '<testsuites/>', 'application/xml');
    return send(404, { message: '不存在' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, LSE_URL: url, LSE_TOKEN: TOKEN, ...env },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('gate：通过=0，未通过=1，任务失败=2，任务不存在=3', async () => {
  assert.equal((await run(['gate', '--task', T_OK])).code, 0);
  const f = await run(['gate', '--task', T_FAIL]);
  assert.equal(f.code, 1);
  assert.match(f.out, /得分过低/);
  assert.equal((await run(['gate', '--task', T_ERR])).code, 2);
  assert.equal((await run(['gate', '--task', 'nope'])).code, 3);
});

test('认证错误=3；缺环境变量=3；用法错误=3；输出不含令牌', async () => {
  const bad = await run(['gate', '--task', T_OK], { LSE_TOKEN: 'lse_ffffffff_' + 'c'.repeat(32) });
  assert.equal(bad.code, 3);
  assert.equal((await run(['gate', '--task', T_OK], { LSE_TOKEN: '' })).code, 3);
  assert.equal((await run(['frobnicate'])).code, 3);
  const all = (await run(['gate', '--task', T_FAIL])).out;
  assert.ok(!all.includes(TOKEN));
});

test('run --plan --wait：触发后等待并按门禁退出；被跳过=2', async () => {
  const ok = await run(['run', '--plan', 'plan-ok', '--wait', '--interval', '1']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /门禁通过/);
  const skip = await run(['run', '--plan', 'plan-skip']);
  assert.equal(skip.code, 2);
  assert.match(skip.out, /间隔不足/);
});

test('export：写出文件', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'lse-ci-')), 'r.xml');
  const r = await run(['export', '--task', T_OK, '--format', 'junit', '--out', out]);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(out, 'utf8'), '<testsuites/>');
});
