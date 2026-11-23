/**
 * 动态容量信号量：把 AdaptiveConcurrency 的「有效并发上限」落到红队模型
 * 真实网络调用上（attacker THINK / target OBSERVE / replay / judge 共用）。
 *
 *   - acquire(signal?)：inFlight<capacity 立即放行；否则挂起。abort 时立即
 *     抛 AbortError 并从等待队列移除（不泄漏许可、不卡住）。
 *   - release()：inFlight-1，按 FIFO 唤醒一个等待者（若容量允许）。
 *   - setCapacity(n)：动态调整容量（AIMD 减半/升并发时调用）。
 *
 * 用法：调用方在 try/finally 里 acquire/release。RedTeamChat 内部包了这层。
 */
export class AsyncSemaphore {
  private capacity: number;
  private inFlight = 0;
  private readonly waiters: Array<{
    onGrant: () => void;
    onAbort: (err: Error) => void;
    signal?: AbortSignal;
    onSignalAbort?: () => void;
  }> = [];

  constructor(capacity: number) {
    this.capacity = Math.max(0, Math.floor(Number.isFinite(capacity) ? capacity : 0));
  }

  get currentCapacity(): number {
    return this.capacity;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      const err = new Error('red team semaphore aborted');
      err.name = 'AbortError';
      throw err;
    }
    if (this.inFlight < this.capacity) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const entry = {
        signal,
        onGrant: () => {
          if (entry.onSignalAbort && signal) {
            signal.removeEventListener('abort', entry.onSignalAbort);
          }
          this.inFlight += 1;
          resolve();
        },
        onAbort: (err: Error) => {
          if (entry.onSignalAbort && signal) {
            signal.removeEventListener('abort', entry.onSignalAbort);
          }
          reject(err);
        },
        onSignalAbort: undefined as undefined | (() => void),
      };
      // 注册 abort 监听：信号触发时把自己移出队列并 reject。
      if (signal) {
        entry.onSignalAbort = () => {
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
          const err = new Error('red team semaphore aborted');
          err.name = 'AbortError';
          entry.onAbort(err);
        };
        signal.addEventListener('abort', entry.onSignalAbort, { once: true });
      }
      this.waiters.push(entry);
    });
  }

  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    if (this.waiters.length > 0 && this.inFlight < this.capacity) {
      const next = this.waiters.shift();
      if (next) next.onGrant();
    }
  }

  /** 动态调整容量。下调挡后续 acquire；上调唤醒等待者。 */
  setCapacity(n: number): void {
    this.capacity = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
    while (this.waiters.length > 0 && this.inFlight < this.capacity) {
      const next = this.waiters.shift();
      if (next) next.onGrant();
    }
  }
}
