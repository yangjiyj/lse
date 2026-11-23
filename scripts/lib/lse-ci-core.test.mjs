import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT,
  classifyTaskStatus,
  describeHttpError,
  evaluateGateResponse,
  exitCodeForHttp,
  maskToken,
  parseArgs,
} from './lse-ci-core.mjs';

test('parseArgs：run 需要 plan 或 task，且二选一', () => {
  assert.match(parseArgs(['run']).error, /--plan/);
  assert.match(parseArgs(['run', '--plan', 'a', '--task', 'b']).error, /之一/);
  const ok = parseArgs(['run', '--plan', 'p1', '--wait', '--timeout', '600']);
  assert.equal(ok.error, null);
  assert.equal(ok.options.plan, 'p1');
  assert.equal(ok.options.wait, true);
  assert.equal(ok.options.timeout, 600);
});

test('parseArgs：支持 --k=v、未知参数/子命令/缺值报错', () => {
  assert.equal(parseArgs(['gate', '--task=abc']).options.task, 'abc');
  assert.match(parseArgs(['gate', '--bogus']).error, /未知参数/);
  assert.match(parseArgs(['deploy']).error, /未知子命令/);
  assert.match(parseArgs(['gate', '--task']).error, /缺少取值/);
  assert.match(parseArgs([]).error, /缺少子命令/);
  assert.match(parseArgs(['wait', '--timeout', 'abc']).error, /正数/);
});

test('parseArgs：export 校验格式与输出文件', () => {
  assert.match(parseArgs(['export', '--task', 't']).error, /--format/);
  assert.match(parseArgs(['export', '--format', 'csv', '--out', 'x']).error, /不支持/);
  assert.match(parseArgs(['export', '--format', 'junit']).error, /--out/);
  assert.equal(parseArgs(['export', '--format', 'sarif', '--out', 'a.sarif']).error, null);
});

test('classifyTaskStatus / exitCodeForHttp', () => {
  assert.equal(classifyTaskStatus('COMPLETED'), 'done');
  assert.equal(classifyTaskStatus('FAILED'), 'failed');
  assert.equal(classifyTaskStatus('CANCELED'), 'failed');
  assert.equal(classifyTaskStatus('RUNNING'), 'running');
  assert.equal(exitCodeForHttp(401), EXIT.USAGE);
  assert.equal(exitCodeForHttp(403), EXIT.USAGE);
  assert.equal(exitCodeForHttp(404), EXIT.USAGE);
  assert.equal(exitCodeForHttp(409), EXIT.EVAL_FAILED);
  assert.equal(exitCodeForHttp(502), EXIT.EVAL_FAILED);
  assert.match(describeHttpError(409, { reason: '间隔不足' }), /间隔不足/);
});

test('evaluateGateResponse：通过 / 未通过 / 任务失败 / 无门禁', () => {
  const base = { taskStatus: 'COMPLETED', evaluated: true };
  const pass = evaluateGateResponse({
    ...base,
    passed: true,
    items: [{ gateName: 'G', passed: true, reasons: [] }],
  });
  assert.equal(pass.code, EXIT.PASS);
  const fail = evaluateGateResponse({
    ...base,
    passed: false,
    items: [{ gateName: 'G', passed: false, reasons: ['得分过低'], metrics: { score: 50 } }],
  });
  assert.equal(fail.code, EXIT.GATE_FAILED);
  assert.ok(fail.lines.some((l) => l.includes('得分过低')));
  assert.equal(evaluateGateResponse({ taskStatus: 'FAILED' }).code, EXIT.EVAL_FAILED);
  const none = evaluateGateResponse({ taskStatus: 'COMPLETED', evaluated: false, items: [] });
  assert.equal(none.code, EXIT.USAGE);
  assert.equal(none.pending, true);
  assert.equal(
    evaluateGateResponse({ taskStatus: 'COMPLETED', evaluated: false }, { allowNoGate: true }).code,
    EXIT.PASS,
  );
});

test('maskToken：令牌明文不会出现在文本里', () => {
  const tok = 'lse_0123abcd_' + 'a'.repeat(32);
  assert.ok(!maskToken(`Bearer ${tok} 失败`, tok).includes('aaaa'));
  assert.ok(!maskToken(`x ${tok}`, '').includes('aaaa'));
});
