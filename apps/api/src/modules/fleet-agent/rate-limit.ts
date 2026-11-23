// 简单的内存令牌桶限流（项目内没有现成实现）。单进程有效；多副本部署时各副本独立计数。
export interface RateLimiter {
  /** 取一个令牌；返回 false 表示超限。 */
  take(key: string): boolean;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * @param capacity 桶容量（允许的突发量）
   * @param perMinute 每分钟补充的令牌数
   * @param maxKeys 最多跟踪的键数，超出时淘汰最早插入的键，防止内存被随机 IP/令牌撑爆
   */
  constructor(
    private readonly capacity: number,
    private readonly perMinute: number,
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { tokens: this.capacity, updatedAt: t };
      this.buckets.set(key, bucket);
    } else {
      const refill = ((t - bucket.updatedAt) / 60_000) * this.perMinute;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
      bucket.updatedAt = t;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

export const noopLimiter: RateLimiter = { take: () => true };
