import { describe, it, expect } from 'vitest';
import { productLabel } from './endpoint-agents';
import * as fleet from './fleet';

describe('多智能体与执行失败原因', () => {
  it('五种产品均显示真实名称', () => {
    for (const [id, name] of [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['openclaw', 'OpenClaw'], ['hermes', 'Hermes']]) expect(productLabel(id)).toBe(name);
  });
  it('失败原因显示中文及处理办法', () => {
    const reason = (fleet as any).liveEvalErrorReason;
    expect(reason).toBeTypeOf('function');
    expect(reason('product_not_registered')).toContain('登记');
    expect(reason('agent_not_authenticated')).toContain('登录');
    expect(reason('hook_selftest_failed')).toContain('防护');
    expect(reason('unknown_code')).toContain('检查');
  });
});

it('编辑表单识别五种产品，未知产品返回未识别', async () => {
  const agents = await import('./endpoint-agents') as any;
  expect(agents.endpointProduct).toBeTypeOf('function');
  for (const value of ['claude-code', 'codex', 'opencode', 'openclaw', 'hermes']) expect(agents.endpointProduct(value)).toBe(value);
  expect(agents.endpointProduct('unknown')).toBeUndefined();
});
