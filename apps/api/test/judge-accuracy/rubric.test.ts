/**
 * 零成本单测（LSE_TEST=1，不调用任何模型）：
 *   验证 rubric 注入只作用于弱类、默认关时不改变现有 prompt、且只动 system 不动 user 段。
 *   纯函数 buildJudgePrompt 测试，不触发 config / 网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JudgeInput, QuestionType } from '@lse/shared';
import { buildJudgePrompt } from '../../src/modules/engines/llm-judge.js';

const RUBRIC_MARK = '【本题为应拒答/合规类';
const WEAK: QuestionType[] = ['SHOULD_REFUSE', 'COMPLIANCE'];
const NON_WEAK: QuestionType[] = ['PROMPT_INJECTION', 'GENERAL'];

function input(questionType: QuestionType, shouldRefuse: boolean): JudgeInput {
  return {
    taskId: 't',
    questionId: 'q',
    questionType,
    prompt: '示例提问',
    response: '示例回答',
    shouldRefuse,
    severity: 'MEDIUM',
  };
}

function sys(msgs: { role: string; content: string }[]): string {
  return msgs[0].content;
}
function usr(msgs: { role: string; content: string }[]): string {
  return msgs[1].content;
}

test('rubric on：弱类（应拒答/合规）注入 rubric', () => {
  for (const qt of WEAK) {
    const on = buildJudgePrompt(input(qt, true), { rubric: true });
    assert.ok(sys(on).includes(RUBRIC_MARK), `${qt} 应注入 rubric`);
  }
});

test('rubric on：非弱类（提示注入/通用）不注入', () => {
  for (const qt of NON_WEAK) {
    const on = buildJudgePrompt(input(qt, true), { rubric: true });
    assert.ok(!sys(on).includes(RUBRIC_MARK), `${qt} 不应注入 rubric`);
  }
});

test('rubric off：默认与显式 false 都不注入，且 system 字节一致', () => {
  for (const qt of [...WEAK, ...NON_WEAK]) {
    const def = buildJudgePrompt(input(qt, true));
    const off = buildJudgePrompt(input(qt, true), { rubric: false });
    assert.ok(!sys(def).includes(RUBRIC_MARK), `${qt} 默认不应注入`);
    assert.equal(sys(def), sys(off), `${qt} 默认与显式 off 的 system 应一致`);
  }
});

test('rubric 仅改 system，user 段始终不变', () => {
  for (const qt of WEAK) {
    const on = buildJudgePrompt(input(qt, true), { rubric: true });
    const off = buildJudgePrompt(input(qt, true), { rubric: false });
    assert.equal(usr(on), usr(off), `${qt} 的 user 段不应因 rubric 改变`);
  }
});
