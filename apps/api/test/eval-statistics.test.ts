import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  binaryMetrics,
  cohensKappa,
  compareProportions,
  describeStatisticsZh,
  statisticsFromTaskRow,
  kappaLevel,
  sampleSizeWarning,
  seededSample,
  summarizeTaskStatistics,
  wilsonInterval,
} from '../src/lib/eval-statistics.js';

const near = (a: number | null, b: number, eps = 1e-3) =>
  assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

describe('wilsonInterval', () => {
  it('n=0 返回空区间', () => {
    const r = wilsonInterval(0, 0);
    assert.equal(r.proportion, null);
    assert.equal(r.lower, null);
  });
  it('10/100 的 95% 区间约 5.5%~17.4%', () => {
    const r = wilsonInterval(10, 100);
    near(r.proportion, 0.1);
    near(r.lower, 0.0552);
    near(r.upper, 0.1744);
  });
  it('0/20 下限为 0，上限约 16.1%', () => {
    const r = wilsonInterval(0, 20);
    assert.equal(r.lower, 0);
    near(r.upper, 0.161);
  });
  it('20/20 上限为 1', () => {
    const r = wilsonInterval(20, 20);
    assert.equal(r.upper, 1);
    near(r.lower, 0.839);
  });
  it('99% 区间比 95% 更宽', () => {
    const a = wilsonInterval(5, 50, 0.95);
    const b = wilsonInterval(5, 50, 0.99);
    assert.ok(b.lower! < a.lower! && b.upper! > a.upper!);
  });
  it('successes 超过 n 或为负时被钳制', () => {
    assert.equal(wilsonInterval(9, 5).successes, 5);
    assert.equal(wilsonInterval(-3, 5).successes, 0);
  });
});

describe('sampleSizeWarning', () => {
  it('分档', () => {
    assert.equal(sampleSizeWarning(0)?.code, 'NO_SAMPLE');
    assert.equal(sampleSizeWarning(9)?.code, 'TOO_FEW');
    assert.equal(sampleSizeWarning(10)?.code, 'FEW');
    assert.equal(sampleSizeWarning(29)?.code, 'FEW');
    assert.equal(sampleSizeWarning(30), null);
  });
});

describe('summarizeTaskStatistics', () => {
  it('未判定计入分母，错误不计入', () => {
    const s = summarizeTaskStatistics({ passed: 60, failed: 30, unknown: 10, error: 5 });
    assert.equal(s.sampleSize, 100);
    near(s.failRate, 0.3);
    near(s.unknownRate, 0.1);
    assert.equal(s.errorCount, 5);
    assert.deepEqual(s.warningCodes, []);
    assert.ok(s.failRateLower! < 0.3 && s.failRateUpper! > 0.3);
  });
  it('小样本给出警告', () => {
    const s = summarizeTaskStatistics({ passed: 3, failed: 2, unknown: 0 });
    assert.deepEqual(s.warningCodes, ['TOO_FEW']);
    assert.equal(s.warnings.length, 1);
  });
  it('未判定占比高时追加警告', () => {
    const s = summarizeTaskStatistics({ passed: 40, failed: 20, unknown: 40 });
    assert.equal(s.warnings.length, 1);
    assert.match(s.warnings[0]!, /未判定/);
  });
  it('无样本', () => {
    const s = summarizeTaskStatistics({ passed: 0, failed: 0, unknown: 0 });
    assert.equal(s.failRate, null);
    assert.deepEqual(s.warningCodes, ['NO_SAMPLE']);
  });
});

describe('二分类指标与 kappa', () => {
  it('准确率/精确率/召回率', () => {
    const m = binaryMetrics({ tp: 40, fp: 10, fn: 5, tn: 45 });
    near(m.accuracy, 0.85);
    near(m.precision, 0.8);
    near(m.recall, 40 / 45);
  });
  it('分母为 0 时为 null', () => {
    const m = binaryMetrics({ tp: 0, fp: 0, fn: 0, tn: 5 });
    assert.equal(m.precision, null);
    assert.equal(m.recall, null);
  });
  it('kappa 经典算例 = 0.7', () => {
    near(cohensKappa({ tp: 40, fp: 10, fn: 5, tn: 45 }), 0.7);
  });
  it('完全一致 kappa=1，完全相反为负', () => {
    near(cohensKappa({ tp: 5, fp: 0, fn: 0, tn: 5 }), 1);
    assert.ok(cohensKappa({ tp: 0, fp: 5, fn: 5, tn: 0 })! < 0);
  });
  it('双方全部同类时 kappa 无法定义', () => {
    assert.equal(cohensKappa({ tp: 10, fp: 0, fn: 0, tn: 0 }), null);
    assert.equal(cohensKappa({ tp: 0, fp: 0, fn: 0, tn: 0 }), null);
  });
  it('kappa 分级文案', () => {
    assert.equal(kappaLevel(null), '无法计算');
    assert.equal(kappaLevel(0.7), '较强');
    assert.equal(kappaLevel(-0.1), '差（不如随机）');
  });
});

describe('compareProportions', () => {
  it('区间重叠 → 未超出统计波动', () => {
    const r = compareProportions({ successes: 12, n: 40 }, { successes: 16, n: 40 });
    assert.equal(r.verdict, 'within_noise');
    near(r.delta, 0.1);
  });
  it('区间明显分离 → 超出波动', () => {
    const r = compareProportions({ successes: 10, n: 200 }, { successes: 80, n: 200 });
    assert.equal(r.verdict, 'beyond_noise');
  });
  it('任一侧无样本 → 数据不足', () => {
    assert.equal(
      compareProportions({ successes: 0, n: 0 }, { successes: 1, n: 5 }).verdict,
      'insufficient',
    );
  });
  it('小样本分离也带谨慎提示', () => {
    const r = compareProportions({ successes: 0, n: 8 }, { successes: 8, n: 8 });
    assert.equal(r.verdict, 'beyond_noise');
    assert.match(r.message, /样本过少/);
  });
});

describe('seededSample', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  it('同种子可复现，不同种子不同', () => {
    assert.deepEqual(seededSample(items, 10, 'a'), seededSample(items, 10, 'a'));
    assert.notDeepEqual(seededSample(items, 10, 'a'), seededSample(items, 10, 'b'));
  });
  it('无放回、数量受限、不改原数组', () => {
    const s = seededSample(items, 100, 1);
    assert.equal(s.length, 50);
    assert.equal(new Set(s).size, 50);
    assert.equal(items[0], 0);
    assert.deepEqual(seededSample(items, 0, 1), []);
  });
});

describe('describeStatisticsZh / statisticsFromTaskRow', () => {
  it('报告一句话包含比例、区间、样本量与未判定说明', () => {
    const text = describeStatisticsZh(
      statisticsFromTaskRow({
        processedQuestions: 100,
        passedCount: 60,
        failedCount: 30,
        errorCount: 0,
      }),
    );
    assert.match(text, /发现风险比例 30\.0%/);
    assert.match(text, /样本量 100/);
    assert.match(text, /95% 置信区间/);
    assert.match(text, /未判定 10 条/);
    assert.match(text, /不计为通过/);
    assert.doesNotMatch(text, /wilson|kappa/i);
  });
  it('无样本返回空串', () => {
    assert.equal(describeStatisticsZh(null), '');
    assert.equal(
      describeStatisticsZh(
        statisticsFromTaskRow({
          processedQuestions: 0,
          passedCount: 0,
          failedCount: 0,
          errorCount: 0,
        }),
      ),
      '',
    );
  });
});
