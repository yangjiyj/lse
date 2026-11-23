/**
 * 红队场景调度队列（替代 pump 的 cursor 线性认领 + 递归 sleep）。
 *
 * 解决 P2：RetryExhausted 后"延后重排一次"必须真正可控——
 *   - 不占住一个 worker 空等 15 秒（worker 去做别的 ready 场景）；
 *   - 重新执行时是全新 attack（不复用半截 transcript）；
 *   - 仅允许一次延后；
 *   - 取消立即清空。
 *
 * worker 协议（next 返回 ScheduleOutcome）：
 *   - {outcome:'ready', question}：取出一个可执行场景（worker 执行它）。
 *   - {outcome:'pending', readyAt}：当前没有 ready 场景，但还有冷却中的延后场景（worker
 *     可选择等待到 readyAt 或退出由上层调度）。
 *   - {outcome:'done'}：所有场景完成（含延后已执行或不再重试）。
 *
 * 执行结果回写：markDone(id) 完成；rescheduleOnce(id, readyAt) 延后（仅一次）。
 */
export interface ScenarioQuestion {
  id: string;
  [k: string]: unknown;
}

export type ScheduleOutcome =
  | { outcome: 'ready'; question: ScenarioQuestion }
  | { outcome: 'pending'; readyAt: number }
  | { outcome: 'done' };

export class ScenarioScheduler {
  private pending: ScenarioQuestion[] = [];
  private deferred: Array<{ question: ScenarioQuestion; readyAt: number }> = [];
  private readonly questionsById = new Map<string, ScenarioQuestion>();
  private inflight = new Set<string>();
  private retried = new Set<string>();
  private aborted = false;
  private readonly now: () => number;

  constructor(questions: ScenarioQuestion[], now: () => number = () => Date.now()) {
    this.pending = [...questions];
    for (const q of questions) this.questionsById.set(q.id, q);
    this.now = now;
  }

  next(): ScheduleOutcome {
    if (this.aborted) return { outcome: 'done' };
    // 把已到冷却的延后场景移回 pending（按 readyAt 升序）
    const now = this.now();
    const stillDeferred: typeof this.deferred = [];
    for (const d of this.deferred) {
      if (now >= d.readyAt) this.pending.push(d.question);
      else stillDeferred.push(d);
    }
    this.deferred = stillDeferred;

    if (this.pending.length > 0) {
      const q = this.pending.shift()!;
      this.inflight.add(q.id);
      return { outcome: 'ready', question: q };
    }
    if (this.deferred.length > 0) {
      const readyAt = Math.min(...this.deferred.map((d) => d.readyAt));
      return { outcome: 'pending', readyAt };
    }
    return { outcome: 'done' };
  }

  markDone(id: string): void {
    this.inflight.delete(id);
  }

  /** RetryExhausted 延后重排：仅允许一次。返回 false 表示已延后过，不能再延后。 */
  rescheduleOnce(id: string, readyAt: number): boolean {
    if (!this.inflight.has(id)) return false;
    if (this.retried.has(id)) return false;
    this.retried.add(id);
    this.inflight.delete(id);
    const question = this.questionsById.get(id) ?? { id };
    this.deferred.push({ question, readyAt });
    return true;
  }

  /** 取消：清空所有队列。 */
  abort(): void {
    this.aborted = true;
    this.pending = [];
    this.deferred = [];
    this.inflight.clear();
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get deferredCount(): number {
    return this.deferred.length;
  }
}
