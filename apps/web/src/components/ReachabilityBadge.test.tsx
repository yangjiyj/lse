import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, test, expect } from 'vitest';
import { ReachabilityBadge } from './ReachabilityBadge';
afterEach(cleanup);
test.each([
  ['not_executed', '前提不满足，未执行'],
  ['blackbox_reached', '黑盒可达'],
  ['inconclusive', '已调用，判定不明确'],
  ['needs_whitebox', '未统计'],
  ['unreachable', '不可达或证据不足'],
  [undefined, '未统计'],
  ['future', '未统计'],
])('可达性显示中文 %s', (value, label) => {
  render(<ReachabilityBadge value={value} />);
  expect(screen.getByLabelText('可达性').textContent).toBe(label);
  expect(screen.getByLabelText('可达性').textContent).not.toMatch(
    /blackbox_reached|needs_whitebox|unreachable|inconclusive/,
  );
});
