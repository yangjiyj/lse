export const KiB = 1024;
export const MiB = 1024 * KiB;
export const GiB = 1024 * MiB;
export const TiB = 1024 * GiB;

/** 面向用户的字节数展示：自动选 B/KiB/MiB/GiB/TiB，整数不带小数，其余保留一位。 */
export function formatBytes(n: number): string {
  const units: Array<[number, string]> = [
    [TiB, 'TiB'],
    [GiB, 'GiB'],
    [MiB, 'MiB'],
    [KiB, 'KiB'],
  ];
  for (const [size, label] of units) {
    if (n >= size) return `${(n / size).toFixed(n % size ? 1 : 0)} ${label}`;
  }
  return `${n} B`;
}
