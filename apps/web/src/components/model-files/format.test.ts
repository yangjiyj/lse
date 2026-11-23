import { describe, it, expect } from 'vitest';
import { estimateReadDuration } from './format';

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;

describe('estimateReadDuration：按每秒 100～500 MiB 估算完整读取一遍要多久', () => {
  it('1 TiB：约 35 分钟到 2.9 小时', () => {
    expect(estimateReadDuration(TiB)).toBe('35 分钟到 2.9 小时');
  });

  it('100 GiB：两端都是分钟时合并写成「3 到 17 分钟」', () => {
    expect(estimateReadDuration(100 * GiB)).toBe('3 到 17 分钟');
  });

  it('16 TiB：两端都是小时，可以超过一天', () => {
    expect(estimateReadDuration(16 * TiB)).toBe('9.3 到 46.6 小时');
  });

  it('慢的一端不到 1 分钟就写「不到 1 分钟」', () => {
    expect(estimateReadDuration(GiB)).toBe('不到 1 分钟');
    expect(estimateReadDuration(5 * GiB)).toBe('不到 1 分钟');
  });

  it('快的一端不足 1 分钟、慢的一端超过时，快的一端按 1 分钟算', () => {
    expect(estimateReadDuration(20 * GiB)).toBe('1 到 3 分钟');
  });

  it('两端取整后相同时只写一个数', () => {
    expect(estimateReadDuration(7 * GiB)).toBe('1 分钟');
  });

  it('0、负数、非数字不给估算', () => {
    expect(estimateReadDuration(0)).toBeNull();
    expect(estimateReadDuration(-1)).toBeNull();
    expect(estimateReadDuration(Number.NaN)).toBeNull();
    expect(estimateReadDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
