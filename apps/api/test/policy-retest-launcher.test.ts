// W4 复测启动器单元测试：发起人缺失不伪造、W3c 错误码逐一透传为复测状态。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { AppError, badRequest, conflict } from '../src/lib/errors.js';
import {
  RETEST_ERROR_STATUS,
  RetestServiceUnavailableError,
  defaultRetestLauncher,
  retestFailureState,
} from '../src/modules/policy-suggestions/retest-launcher.js';

/** 任何数据库访问都直接失败：证明发起人缺失时不会去查父任务创建人来顶替。 */
const untouchableDb = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`不应访问数据库：${String(prop)}`);
    },
  },
) as unknown as PrismaClient;

for (const actorId of [null, '', undefined]) {
  test(`发起人为 ${JSON.stringify(actorId)} 时拒绝发起，不用父任务创建人顶替`, async () => {
    await assert.rejects(
      defaultRetestLauncher.launch(untouchableDb, 'parent-1', {
        actorId: actorId as string | null,
      }),
      (err: unknown) =>
        err instanceof AppError && err.code === 'RETEST_ACTOR_MISSING' && err.statusCode === 400,
    );
  });
}

test('发起人缺失映射为 ACTOR_MISSING 状态', () => {
  const s = retestFailureState(badRequest('无法确定复测发起人', 'RETEST_ACTOR_MISSING'));
  assert.equal(s.status, 'ACTOR_MISSING');
  assert.match(s.error, /^复测未发起：/);
});

const W3C_CODES: Array<[string, number, string]> = [
  ['RETEST_NO_FAILED_QUESTIONS', 409, 'NO_FAILED_QUESTIONS'],
  ['RETEST_PARENT_NOT_FINISHED', 409, 'PARENT_NOT_FINISHED'],
  ['RETEST_NOT_SUPPORTED', 400, 'NOT_SUPPORTED'],
  ['RETEST_FINDING_SCOPE_MISMATCH', 409, 'FINDING_SCOPE_MISMATCH'],
  ['REMEDIATION_CLOSED_IMMUTABLE', 409, 'REMEDIATION_CLOSED'],
  ['RETEST_TARGET_NOT_EXECUTABLE', 400, 'TARGET_NOT_EXECUTABLE'],
];

for (const [code, http, status] of W3C_CODES) {
  test(`W3c 错误码 ${code}(${http}) 映射为 ${status}，保留原因`, () => {
    const err = http === 409 ? conflict(`原因-${code}`, code) : badRequest(`原因-${code}`, code);
    const s = retestFailureState(err);
    assert.equal(s.status, status);
    assert.equal(s.error, `复测未发起：原因-${code}`);
    assert.equal(RETEST_ERROR_STATUS[code], status);
  });
}

test('复测服务不可用 → SERVICE_UNAVAILABLE；未识别错误 → LAUNCH_FAILED', () => {
  assert.equal(
    retestFailureState(new RetestServiceUnavailableError()).status,
    'SERVICE_UNAVAILABLE',
  );
  const other = retestFailureState(new Error('boom'));
  assert.equal(other.status, 'LAUNCH_FAILED');
  assert.equal(other.error, '复测发起失败：boom');
  assert.equal(
    retestFailureState(badRequest('x', 'MODEL_TARGET_INACTIVE')).status,
    'LAUNCH_FAILED',
  );
});
