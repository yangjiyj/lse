// 任务结束回调钩子：由评估结果入库车道注册（registerFleetJobFinishedHook），本模块在
// POST /eval-jobs/:id/result 把任务置为 COMPLETED / FAILED 并提交后调用。
// 参数 jobId 是 FleetEvalJob.id（内部 UUID，不是下发给采集器的 publicId）。
// 钩子异步执行、失败只记日志，不影响返回给采集器的应答。
export type FleetJobFinishedHook = (jobId: string) => void | Promise<void>;

const hooks = new Set<FleetJobFinishedHook>();

/** 注册钩子，返回取消注册函数。 */
export function registerFleetJobFinishedHook(hook: FleetJobFinishedHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/** 依次调用所有已注册钩子；单个钩子抛错不影响其他钩子。默认无钩子即空实现。 */
export async function onFleetJobFinished(
  jobId: string,
  onError: (err: unknown) => void = () => {},
): Promise<void> {
  for (const hook of [...hooks]) {
    try {
      await hook(jobId);
    } catch (err) {
      onError(err);
    }
  }
}
