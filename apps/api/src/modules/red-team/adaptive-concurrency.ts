/**
 * 任务级自适应并发控制器（AIMD：Additive Increase / Multiplicative Decrease）。
 *
 * 所有红队模型角色（攻击脑 THINK / 被测模型 OBSERVE / replay / 裁判）共享同一个
 * 任务级控制器实例。它只负责「调度调用时的有效并发上限」，不改变模型目标、攻击
 * 话术、上下文或裁判口径。
 *
 * 规则（与 spec「任务级自适应并发」一致）：
 *   - 初始有效并发 = maxConcurrency（来自任务 concurrency，下限钳为 1）。
 *   - retryable 错误：onError() 立即把有效并发减半，最低为 1（4->2->1，3->1）。
 *   - 连续 SUCCESS_THRESHOLD(8) 次成功：onSuccess() 有效并发 +1，封顶 maxConcurrency。
 *   - 成功计数在遇到任何错误时清零（连续被打断则重来）。
 *
 * 纯逻辑，无 Date.now / Math.random / 网络，便于单测。
 */

export const ADAPTIVE_SUCCESS_THRESHOLD = 8;

export interface ConcurrencyChange {
  previous: number;
  effective: number;
  /** increase=恢复升并发，decrease=降并发，steady=无变化 */
  reason: 'increase' | 'decrease' | 'steady';
  recovered: boolean;
}

export class AdaptiveConcurrency {
  /** 配置上限（构造时的 maxConcurrency，下限 1）。 */
  readonly max: number;
  private effective: number;
  private successStreak = 0;

  constructor(maxConcurrency: number) {
    this.max = Math.max(1, Math.floor(Number.isFinite(maxConcurrency) ? maxConcurrency : 1));
    this.effective = this.max;
  }

  /** 当前有效并发上限（不低于 1，不高于初始配置上限）。 */
  current(): number {
    return this.effective;
  }

  /**
   * 一次 retryable 失败：有效并发减半（下取整），最低 1；成功连续计数清零。
   * 返回变更前后的有效并发，供任务日志记录。
   */
  onError(): ConcurrencyChange {
    const previous = this.effective;
    this.successStreak = 0;
    const next = Math.max(1, Math.floor(previous / 2));
    this.effective = next;
    return {
      previous,
      effective: next,
      reason: next < previous ? 'decrease' : 'steady',
      recovered: false,
    };
  }

  /**
   * 一次成功：连续计数 +1；达阈值(8)且未到上限则 +1，计数清零。
   * recovered=true 表示本次成功触发了升并发（用于 UI「自动恢复并发」展示）。
   */
  onSuccess(): ConcurrencyChange {
    const previous = this.effective;
    this.successStreak += 1;
    if (this.successStreak >= ADAPTIVE_SUCCESS_THRESHOLD && this.effective < this.max) {
      this.effective = Math.min(this.max, this.effective + 1);
      this.successStreak = 0;
      return {
        previous,
        effective: this.effective,
        reason: 'increase',
        recovered: true,
      };
    }
    return { previous, effective: this.effective, reason: 'steady', recovered: false };
  }
}
