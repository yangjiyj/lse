import { describe, expect, it } from 'vitest';
import { isContentEvalTarget, isAgentEvalTarget } from './eval-targets';

describe('评估对象类型门', () => {
  it('平台应用进入内容和智能体测评，保留现有类型限制', () => {
    for (const targetType of ['MODEL', 'PLATFORM_APP']) {
      expect(isAgentEvalTarget({ targetType, isActive: true }, true)).toBe(true);
      expect(isContentEvalTarget({ targetType, isActive: true }, true)).toBe(true);
    }
    expect(isContentEvalTarget({ targetType: 'AGENT_API', isActive: true })).toBe(true);
    expect(isAgentEvalTarget({ targetType: 'AGENT_API', isActive: true })).toBe(false);
    for (const targetType of ['JUDGE', 'GATEWAY_LOG', 'MCP_OPENAPI']) {
      expect(isAgentEvalTarget({ targetType, isActive: true }, true)).toBe(false);
      expect(isContentEvalTarget({ targetType, isActive: true }, true)).toBe(false);
    }
    expect(isContentEvalTarget({ targetType: 'PLATFORM_APP', isActive: false })).toBe(false);
    expect(isAgentEvalTarget({ targetType: 'PLATFORM_APP', isActive: false })).toBe(false);
  });
});

it('能力关闭或未知时隐藏已保存的平台对象评估入口', () => {
  expect(isContentEvalTarget({ targetType: 'PLATFORM_APP', isActive: true })).toBe(false);
  expect(isAgentEvalTarget({ targetType: 'PLATFORM_APP', isActive: true }, false)).toBe(false);
});
