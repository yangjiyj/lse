export interface Rng {
  next(): number; // [0,1)
  int(maxExclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  shuffle<T>(arr: readonly T[]): T[];
}

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed: string): Rng {
  const seeder = xmur3(seed);
  const next = mulberry32(seeder());
  const rng: Rng = {
    next,
    int: (maxExclusive: number) => {
      if (maxExclusive <= 0) throw new RangeError('maxExclusive must be > 0');
      return Math.floor(next() * maxExclusive);
    },
    pick: <T>(arr: readonly T[]): T => {
      if (arr.length === 0) throw new RangeError('Cannot pick from empty array');
      return arr[Math.floor(next() * arr.length)]!; // 长度守卫保证索引在 [0, length) 内
    },
    shuffle: <T>(arr: readonly T[]): T[] => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!]; // i/j 均在 [0, out.length) 内
      }
      return out;
    },
  };
  return rng;
}
