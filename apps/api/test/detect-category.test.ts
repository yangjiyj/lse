import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DETECT_CATEGORIES,
  DETECT_CATEGORY_LABELS,
  DETECT_RECORD_KINDS,
  detectCategoryOfEvalTask,
  isDetectCategory,
} from '@lse/shared';

// 二期共用的四类检测口径（模型、数据、内容、应用与环境），保密本期不做。

test('四类都有中文名，记录类型都归到四类之一', () => {
  assert.deepEqual([...DETECT_CATEGORIES], ['model', 'data', 'content', 'app_env']);
  for (const c of DETECT_CATEGORIES) assert.ok(DETECT_CATEGORY_LABELS[c]);
  for (const [kind, c] of Object.entries(DETECT_RECORD_KINDS)) assert.ok(isDetectCategory(c), kind);
  assert.equal(DETECT_RECORD_KINDS.corpus_scan, 'data');
  assert.equal(DETECT_RECORD_KINDS.model_file_scan, 'model');
});

test('评估任务：智能体安全评测归应用与环境，国标和红队归内容安全', () => {
  assert.equal(
    detectCategoryOfEvalTask({ engines: [], dimensions: ['agent_tool_call'] }),
    'app_env',
  );
  assert.equal(
    detectCategoryOfEvalTask({ engines: ['standard-output-v1'], dimensions: [] }),
    'content',
  );
  assert.equal(
    detectCategoryOfEvalTask({ engines: ['autonomous-red-team'], dimensions: [] }),
    'content',
  );
  assert.equal(isDetectCategory('secrecy'), false);
});
