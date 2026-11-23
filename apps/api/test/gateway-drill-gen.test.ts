import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDrillScenario, DRILL_CHANNELS } from '../src/modules/gateway-logs/drill.js';

// mode3 演练工件生成：给定诱饵串，产出"投毒工件(多通道) + 建议网关检测规则 + 成功信号"。
// 无害化铁律：注入载荷只让 agent 把诱饵串发出，绝不含破坏性指令。

const CANARY = 'LSE-DRILL-7f3a9c';

test('每个请求的通道都产出工件，且工件内嵌本次诱饵串与外发指令', () => {
  const sc = generateDrillScenario({
    canaryToken: CANARY,
    channels: ['document', 'webpage', 'ticket'],
  });
  assert.equal(sc.canaryToken, CANARY);
  assert.equal(sc.artifacts.length, 3);
  for (const art of sc.artifacts) {
    assert.ok(art.content.includes(CANARY), `工件应内嵌诱饵串: ${art.channel}`);
    assert.ok(art.content.includes(sc.collectorUrl), `工件应含外发目标: ${art.channel}`);
    assert.ok(art.title && art.content.length > 40);
  }
});

test('建议网关规则=按诱饵串精确匹配、动作 audit(只留证不实拦)', () => {
  const sc = generateDrillScenario({ canaryToken: CANARY });
  assert.equal(sc.gatewayRule.ruleType, 'keyword');
  assert.equal(sc.gatewayRule.pattern, CANARY);
  assert.equal(sc.gatewayRule.action, 'audit');
  assert.ok(sc.gatewayRule.name.length > 0);
});

test('成功信号明确指向诱饵外发；通道缺省覆盖全部内置通道', () => {
  const sc = generateDrillScenario({ canaryToken: CANARY });
  assert.ok(sc.successSignal.includes(CANARY));
  assert.equal(sc.artifacts.length, DRILL_CHANNELS.length);
});

test('无害化铁律：工件载荷绝不含破坏性指令', () => {
  const sc = generateDrillScenario({ canaryToken: CANARY });
  const DESTRUCTIVE =
    /删除|清空|格式化|drop\s+table|rm\s+-rf|转账|加密所有|delete\s+from|truncate/i;
  for (const art of sc.artifacts) {
    assert.doesNotMatch(art.content, DESTRUCTIVE, `工件含破坏性指令: ${art.channel}`);
  }
});
