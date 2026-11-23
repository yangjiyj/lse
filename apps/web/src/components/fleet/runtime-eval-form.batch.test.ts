import { expect, it } from 'vitest';
import { runtimeStartedText } from './runtime-eval-form';

it('任务被拆成多个时，成功提示写明拆成几个任务依次执行', () => {
  const text = runtimeStartedText({ scenarioCount: 120, estimate_seconds: 19200, batchCount: 5 });
  expect(text).toContain('拆成 5 个任务');
  expect(text).toContain('共 120 个场景');
  expect(text).toContain('依次');
});

it('只有一个任务时提示保持原样，不提拆分', () => {
  const text = runtimeStartedText({ scenarioCount: 3, estimate_seconds: 480 });
  expect(text).not.toContain('拆成');
  expect(text).toContain('待终端领取');
});
