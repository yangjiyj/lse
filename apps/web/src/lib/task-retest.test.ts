import { describe, expect, it } from 'vitest';
import { reEvalBlockedReason } from './task-retest';

const base = {
  status: 'COMPLETED',
  engines: ['rule-judge'],
  modelTarget: { targetType: 'MODEL' },
  standardRun: null,
};

describe('reEvalBlockedReason：与后端重新评估接口同一口径', () => {
  it('终端配置体检可直接重新检测，真机需再次确认', () => {
    expect(
      reEvalBlockedReason({
        ...base,
        endpointMode: 'posture',
        name: '终端配置体检',
        modelTarget: { targetType: 'ENDPOINT_AGENT' },
        engines: ['endpoint-agent-eval'],
      }),
    ).toBeNull();
  });

  it('普通内容评估任务可以复测', () => {
    expect(reEvalBlockedReason(base)).toBeNull();
  });

  it('终端智能体对象（配置体检、真机测评）不显示通用复测，并指向对象详情页', () => {
    expect(reEvalBlockedReason({ ...base, modelTarget: { targetType: 'ENDPOINT_AGENT' } })).toBe(
      '真机测评需要重新选择智能体和风险范围，并确认影响，请通过新建评估发起。',
    );
  });

  it('引擎含终端智能体测评的任务同样不可复测', () => {
    expect(reEvalBlockedReason({ ...base, engines: ['endpoint-agent-eval'] })).toBe(
      '真机测评需要重新选择智能体和风险范围，并确认影响，请通过新建评估发起。',
    );
  });

  it('标准专项、历史 AIG、间接提示注入各有明确原因', () => {
    expect(reEvalBlockedReason({ ...base, standardRun: { id: 'r1' } })).toContain('标准');
    expect(reEvalBlockedReason({ ...base, engines: ['ai-infra-guard'] })).toContain('历史 AIG');
    expect(reEvalBlockedReason({ ...base, engines: ['agent-fanout'] })).toContain('间接提示注入');
  });

  it('运行中的任务不在这里拦截（按钮只是暂时置灰）', () => {
    expect(reEvalBlockedReason({ ...base, status: 'RUNNING' })).toBeNull();
  });

  it('缺少对象信息或引擎时不误判', () => {
    expect(reEvalBlockedReason({ status: 'COMPLETED', engines: [], modelTarget: null })).toBeNull();
    expect(reEvalBlockedReason({ status: 'COMPLETED', engines: [] })).toBeNull();
  });
});
