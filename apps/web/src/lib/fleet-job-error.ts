import { productLabel } from './endpoint-agents';
import { LIVE_EVAL_BLOCKED_REASONS } from '../../../../packages/shared/src/fleet-live-eval';
/** 面向管理员显示原因和下一步，不把终端内部错误码直接放到界面。 */
export function fleetJobError(code: string | null | undefined, product?: string): string {
  const known: Record<string, string> = {
    product_not_registered: `这台电脑没有登记 ${product ? productLabel(product) : '所选智能体'} 的测评，无法运行。请在终端上登记后再测，或改选已登记的智能体。`,
    invalid_result: '终端返回的结果不完整或格式不正确。请更新探针与测评执行器后重新检测。',
    scenario_failed:
      '测评场景执行出错，本次不能确认安全。请终端管理员检查智能体登录、运行权限和模型连接后重试。',
    partial_scenario_failed:
      '部分测评场景没有跑完（出错或超时），已完成的场景结果仍可查看。请查看这些场景的运行记录，处理后重新检测。',
    all_scenarios_skipped:
      '终端跳过了全部测评场景，没有产生检查结论。请核对智能体的测评登记、启动命令和系统隔离是否可用后重试。',
    scenario_timeout: '测评场景等待超时，没有完成检查。请检查终端网络、模型连接和运行记录后重试。',
    runner_timeout:
      '终端测评执行超时。请检查终端是否在线，以及智能体和模型服务是否能够正常响应后重试。',
    expired: '终端未在截止时间前完成任务。请确认终端在线，取消遗留任务后重新发起。',
    registry_untrusted:
      '终端测评登记文件未通过可信检查。请终端管理员核对登记文件权限和所有者后重新检测。',
  };
  const key = (code ?? '').toLowerCase();
  return (
    known[key] ??
    (Object.hasOwn(LIVE_EVAL_BLOCKED_REASONS, key) ? LIVE_EVAL_BLOCKED_REASONS[key] : undefined) ??
    '终端任务未能完成，暂时没有可用结论。请终端管理员检查探针与智能体的运行记录后重试。'
  );
}
