/**
 * 裁判模型熔断器：一次运行内共用。
 * 裁判模型上游断了的时候，每道题都去打一次失败调用既浪费又掩盖问题。
 * 连续失败达到阈值就进入「故障」状态：之后不再逐题调用，只每隔一段时间放行一次真实调用做恢复探测，
 * 探测成功就退出故障状态。进入、退出各写一条日志，不逐题刷屏。
 */

export interface JudgeFault {
  reason: string;
  /** 进入故障状态的时间（ISO）。 */
  since: string;
  /** 最近一次探测或调用的时间（ISO）。 */
  lastCheckedAt: string;
}

export interface JudgeBreakerOptions {
  /** 连续失败多少次进入故障状态，默认 5。 */
  threshold?: number;
  /** 故障期间放行真实调用的间隔，默认 30 秒。 */
  probeIntervalMs?: number;
  now?: () => number;
  /** 故障状态变化（进入、更新探测时间、退出）时调用，用于持久化；退出时传 null。 */
  onChange?: (fault: JudgeFault | null) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 上一次留下的故障状态（补跑判定时从抽样计划读入）。 */
  initialFault?: JudgeFault | null;
}

export const DEFAULT_BREAKER_THRESHOLD = 5;
export const DEFAULT_PROBE_INTERVAL_MS = 30_000;

export class JudgeBreaker {
  private failures = 0;
  private current: JudgeFault | null;
  private lastProbeAt = 0;
  /** 调用（含探测）发生过的次数：没发生过调用说明这次运行没有需要裁判模型的判定。 */
  attempts = 0;
  private readonly threshold: number;
  private readonly probeIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: JudgeBreakerOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_BREAKER_THRESHOLD;
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.current = options.initialFault ?? null;
  }

  get fault(): JudgeFault | null {
    return this.current;
  }

  get faulted(): boolean {
    return this.current !== null;
  }

  /** 这次要不要真的调用裁判模型。故障期间只在到探测间隔时放行一次。 */
  allow(): boolean {
    if (!this.current) return true;
    const t = this.now();
    if (t - this.lastProbeAt < this.probeIntervalMs) return false;
    this.lastProbeAt = t;
    return true;
  }

  /** 记录一次真实调用的结果。成功清零连续失败数；故障期间的成功即退出故障。 */
  record(success: boolean, reason?: string): void {
    this.attempts += 1;
    if (success) {
      this.failures = 0;
      if (this.current) {
        this.current = null;
        this.options.onChange?.(null);
        this.options.log?.('info', '裁判模型已恢复，继续正常判定；故障期间没判的题会在本轮判定结束前自动补判。');
      }
      return;
    }
    this.failures += 1;
    const why = reason?.trim() || '调用失败';
    if (this.current) {
      this.current = { ...this.current, lastCheckedAt: new Date(this.now()).toISOString() };
      this.options.onChange?.(this.current);
      return;
    }
    if (this.failures >= this.threshold) {
      this.enter(why);
      this.options.log?.(
        'warn',
        `裁判模型连续 ${this.failures} 次调用失败（${why}），已暂停逐题调用：技术抽检里分类模型那部分先不判，拒答题先按规则临时预判；约每 ${Math.round(this.probeIntervalMs / 1000)} 秒探测一次，恢复后自动继续。`,
      );
    }
  }

  /** 预检失败直接进入故障状态（不需要连续失败 5 次）；日志由调用方写。 */
  trip(reason: string): void {
    this.attempts += 1;
    this.failures = Math.max(this.failures, this.threshold);
    if (!this.current) this.enter(reason.trim() || '调用失败');
  }

  /** 预检成功：清零失败数，并清掉之前留下的故障状态。 */
  clear(): void {
    this.failures = 0;
    if (this.current) {
      this.current = null;
      this.options.onChange?.(null);
    }
  }

  private enter(reason: string): void {
    const iso = new Date(this.now()).toISOString();
    this.current = { reason, since: iso, lastCheckedAt: iso };
    // 刚失败过，下一次探测等一个间隔之后。
    this.lastProbeAt = this.now();
    this.options.onChange?.(this.current);
  }
}
