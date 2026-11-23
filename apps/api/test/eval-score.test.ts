import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shared from '@lse/shared';
import { classifyEvalTask, computePassRate } from '@lse/shared';

test('评测得分只保留一套口径：旧 computeEvalScore 已移除', () => {
  assert.equal('computeEvalScore' in shared, false);
  assert.equal(typeof shared.computeWeightedScore, 'function');
});

test('computePassRate：无已判定样本返回 null', () => {
  assert.equal(computePassRate(0, 0), null);
  assert.equal(computePassRate(3, 1), 0.75);
});

test('classifyEvalTask 按发起入口写入的标识分类', () => {
  assert.equal(
    classifyEvalTask({ engines: [], dimensions: ['redteam_attack', 'refusal'] }),
    'redteam',
  );
  assert.equal(classifyEvalTask({ engines: ['standard-output-v1'], dimensions: [] }), 'standard');
  assert.equal(
    classifyEvalTask({ engines: [], dimensions: ['comprehensive', 'redteam_attack'] }),
    'comprehensive',
  );
  assert.equal(classifyEvalTask({ engines: [], dimensions: ['agent_tool_call'] }), 'agent');
  assert.equal(
    classifyEvalTask({ engines: ['rule-judge'], dimensions: ['compliance'] }),
    'content',
  );
  assert.equal(classifyEvalTask({ engines: ['rule-judge'], dimensions: [] }), 'regression');
});
