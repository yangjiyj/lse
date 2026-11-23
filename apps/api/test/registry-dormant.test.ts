import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDormantTaskLevelEngines } from '../src/modules/engines/registry.js';

// P0-2：任务级红队引擎在当前环境（LSE_TEST=1 下被门控关闭，或缺少 sidecar）处于「休眠态」。
// 解析器须把「用户显式勾选、但当前不可用」的任务级引擎单列出来，供执行器落 SKIPPED 运行记录，
// 让「跳过扫描」显式可见，杜绝静默 0 扫描被误读为「无风险」。
//
// 环境前提（见下方 before 守卫）：本套用例整跑在 LSE_TEST=1 下，externalsEnabled()=false，
// 故 garak / pyrit 两个现役任务级引擎 isEnabled() 恒为 false，
// 「被勾选的任务级引擎」⇔「休眠引擎」。
//
// 关于 `!isEngineEnabled` 谓词的覆盖说明：其「已启用任务级引擎应被排除（避免与正常运行重复落账）」
// 这一半，在 LSE_TEST=1 下无法构造（门控恒关；且不应为测试在生产签名上加注入参数 —— 反模式）。
// 与同级 resolveTaskLevelEngines 的门控行为一致，该半的端到端覆盖规划在集成层：Task 4 给
// executor 接入本函数后，test/engine-selection.test.ts「仅任务级引擎」用例将断言被勾选但当前关闭的
// 任务级引擎落 SKIPPED 行（当前该用例仅断言单题兜底回退，尚未覆盖 SKIPPED 行）。
// 本单测只锁定「task-level ∩ selected ∩ disabled」在固定环境下的解析。

before(() => {
  // 显式锁定前置环境：跑错环境（未设 LSE_TEST）会让下面的「休眠」断言整体反转，
  // 这里提前以清晰信息失败，而非抛出令人困惑的零散断言错误。
  assert.equal(
    process.env.LSE_TEST,
    '1',
    '本测试须在 LSE_TEST=1 下运行（任务级引擎因 externalsEnabled()=false 全部门控关闭）',
  );
});

test('未勾选任何引擎 → 无休眠引擎（不臆造跳过项）', () => {
  assert.deepEqual(resolveDormantTaskLevelEngines([]), []);
  assert.deepEqual(resolveDormantTaskLevelEngines(), []);
});

test('历史任务仍带已退役 AIG 标识 → 忽略且不再创建休眠运行', () => {
  assert.deepEqual(resolveDormantTaskLevelEngines(['ai-infra-guard']), []);
});

test('显式勾选多个不可用任务级引擎 → 全部列为休眠（按引擎目录顺序）', () => {
  // 已退役标识被忽略；其余结果仍按 garak→pyrit 的目录顺序输出。
  assert.deepEqual(resolveDormantTaskLevelEngines(['ai-infra-guard', 'garak', 'pyrit']), [
    'garak',
    'pyrit',
  ]);
});

test('勾选顺序打乱 + 重复 → 输出仍按目录顺序去重', () => {
  // 入参顺序被忽略、重复项被折叠：解析走「遍历目录」而非「遍历 selected」，
  // 结果是「休眠引擎集合」语义，供执行器逐一补落 SKIPPED。
  assert.deepEqual(resolveDormantTaskLevelEngines(['pyrit', 'garak', 'pyrit', 'ai-infra-guard']), [
    'garak',
    'pyrit',
  ]);
});

test('混入单题引擎与未知名 → 仅返回被勾选的不可用任务级引擎', () => {
  // rule-judge/sensitive-info 是单题引擎（且恒启用）、unknown 不在目录 → 均不应混入休眠列表。
  assert.deepEqual(
    resolveDormantTaskLevelEngines(['rule-judge', 'garak', 'sensitive-info', 'unknown-x']),
    ['garak'],
  );
});
