import { describe, expect, it } from 'vitest';
import { normalizeVisibleRoundNumber, roundNumberFromZeroBasedIndex } from '@lse/shared';

describe('客户可见轮次转换', () => {
  it('把内部零基索引转换为从 1 开始的人类轮次', () => {
    expect(roundNumberFromZeroBasedIndex(0, 9)).toBe(1);
    expect(roundNumberFromZeroBasedIndex(5, 9)).toBe(6);
  });

  it('非法零基索引回退到数组位置对应的人类轮次', () => {
    expect(roundNumberFromZeroBasedIndex(-1, 2)).toBe(3);
    expect(roundNumberFromZeroBasedIndex(Number.NaN, 3)).toBe(4);
    expect(roundNumberFromZeroBasedIndex(1.5, 4)).toBe(5);
  });

  it('已经是一基轮次时保持原值，不重复加一', () => {
    expect(normalizeVisibleRoundNumber(1, 9)).toBe(1);
    expect(normalizeVisibleRoundNumber(3, 9)).toBe(3);
  });

  it('一基轮次为 0 或非法值时使用安全回退且永不显示第 0 轮', () => {
    expect(normalizeVisibleRoundNumber(0, 4)).toBe(4);
    expect(normalizeVisibleRoundNumber(-1, 2)).toBe(2);
    expect(normalizeVisibleRoundNumber(undefined, 0)).toBe(1);
  });
});
