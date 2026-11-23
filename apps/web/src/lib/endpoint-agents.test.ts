import { describe, expect, it } from 'vitest';
import {
  isEndpointOnline,
  osLabel,
  productLabel,
  suggestedEndpointTargetName,
  supportsLiveEval,
} from './endpoint-agents';

const NOW = new Date('2026-10-22T12:00:00+08:00').getTime();

describe('终端智能体辅助函数', () => {
  it('最近上线超过 24 小时或缺失视为离线', () => {
    expect(isEndpointOnline({ last_seen_at: '2026-10-22T10:00:00+08:00' }, NOW)).toBe(true);
    expect(isEndpointOnline({ last_seen_at: '2026-10-21T12:00:01+08:00' }, NOW)).toBe(true);
    expect(isEndpointOnline({ last_seen_at: '2026-10-21T11:59:00+08:00' }, NOW)).toBe(false);
    expect(isEndpointOnline({ last_seen_at: null }, NOW)).toBe(false);
    expect(isEndpointOnline({ last_seen_at: 'bad' }, NOW)).toBe(false);
  });
  it('真机测评需评估执行器且该产品支持无界面运行', () => {
    const agents = [
      { product: 'claude-code' as const, headless_capable: true },
      { product: 'codex' as const, headless_capable: false },
    ];
    expect(supportsLiveEval({ eval_runner_version: '1', agents }, 'claude-code')).toBe(true);
    expect(supportsLiveEval({ eval_runner_version: '1', agents }, 'codex')).toBe(false);
    expect(supportsLiveEval({ eval_runner_version: null, agents }, 'claude-code')).toBe(false);
  });
  it('中文标签与建议名称', () => {
    expect(productLabel('claude-code')).toBe('Claude Code');
    expect(osLabel('windows')).toBe('Windows');
    expect(suggestedEndpointTargetName('demo-host', 'codex')).toBe('demo-host 终端(Codex)');
  });
});
