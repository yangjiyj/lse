import { describe, expect, it } from 'vitest';
import { describeCron } from './cron-describe';
import { planFormToInput, planToForm } from './eval-plan-form';

describe('describeCron 中文说明', () => {
  it('常见写法', () => {
    expect(describeCron('0 2 * * *')).toBe('每天 02:00');
    expect(describeCron('30 3 * * 1')).toBe('每周一 03:30');
    expect(describeCron('0 2 * * 1-5')).toBe('每个工作日 02:00');
    expect(describeCron('0 9 * * 1,3,5')).toBe('每周一、周三、周五 09:00');
    expect(describeCron('0 4 1 * *')).toBe('每月 1 日 04:00');
    expect(describeCron('0 */6 * * *')).toBe('每 6 小时（第 0 分）');
    expect(describeCron('15 * * * *')).toBe('每小时第 15 分');
    expect(describeCron('*/30 * * * *')).toBe('每 30 分钟');
  });
  it('无法识别的写法原样标注为自定义', () => {
    expect(describeCron('0 2 1-7 * 1')).toBe('自定义：0 2 1-7 * 1');
    expect(describeCron('0 2 * 1 *')).toBe('自定义：0 2 * 1 *');
    expect(describeCron('bad')).toBe('自定义：bad');
  });
});

describe('计划表单转换', () => {
  const base = {
    ...planToForm(null),
    name: ' 每日回归 ',
    targetId: 'm1',
    questionSetIds: ['s1'],
  };

  it('默认值：cron 每天 02:00、最小间隔 60 分钟、内置引擎', () => {
    const f = planToForm(null);
    expect(f.cron).toBe('0 2 * * *');
    expect(f.minIntervalMinutes).toBe('60');
    expect(f.timezone).toBe('Asia/Shanghai');
    expect(f.engines).toEqual(['rule-judge', 'sensitive-info']);
  });

  it('校验必填与范围', () => {
    expect(planFormToInput({ ...base, name: '' })).toBe('请填写计划名称');
    expect(planFormToInput({ ...base, targetId: '' })).toBe('请选择评估对象');
    expect(planFormToInput({ ...base, questionSetIds: [] })).toBe('请至少选择一个样本库');
    expect(planFormToInput({ ...base, cron: '0 2 * *' })).toMatch(/5 段/);
    expect(planFormToInput({ ...base, minIntervalMinutes: '3' })).toMatch(/最小间隔/);
    expect(planFormToInput({ ...base, concurrency: '40' })).toMatch(/并发数/);
  });

  it('生成入参；内置引擎始终带上', () => {
    expect(planFormToInput({ ...base, engines: ['garak'], sampleSize: '100' })).toEqual({
      name: '每日回归',
      description: null,
      targetId: 'm1',
      cron: '0 2 * * *',
      timezone: 'Asia/Shanghai',
      minIntervalMinutes: 60,
      enabled: true,
      templateParams: {
        questionSetIds: ['s1'],
        engines: ['rule-judge', 'sensitive-info', 'garak'],
        concurrency: 4,
        sampleSize: 100,
      },
    });
  });

  it('编辑时抽样题数不变沿用原种子，变了则清空种子交后端重新生成', () => {
    const prev = { questionSetIds: ['s1'], sampleSize: 100, sampleSeed: 'seed-1' };
    const same = planFormToInput({ ...base, sampleSize: '100' }, prev);
    expect(typeof same !== 'string' && same.templateParams.sampleSeed).toBe('seed-1');
    const changed = planFormToInput({ ...base, sampleSize: '200' }, prev);
    expect(typeof changed !== 'string' && changed.templateParams.sampleSeed).toBeUndefined();
    const full = planFormToInput({ ...base, sampleSize: '' }, prev);
    expect(typeof full !== 'string' && full.templateParams).toEqual({
      questionSetIds: ['s1'],
      engines: ['rule-judge', 'sensitive-info'],
      concurrency: 4,
    });
  });
});
