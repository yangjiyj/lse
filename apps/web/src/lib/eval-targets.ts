interface EvalTargetShape {
  targetType?: string;
  isActive: boolean;
}

export function isContentEvalTarget(target: EvalTargetShape, platformAppEnabled = false): boolean {
  if (target.targetType === 'PLATFORM_APP' && !platformAppEnabled) return false;
  return (
    target.isActive && ['MODEL', 'AGENT_API', 'PLATFORM_APP'].includes(target.targetType ?? 'MODEL')
  );
}

export function isAgentEvalTarget(target: EvalTargetShape, platformAppEnabled = false): boolean {
  if (target.targetType === 'PLATFORM_APP' && !platformAppEnabled) return false;
  return target.isActive && ['MODEL', 'PLATFORM_APP'].includes(target.targetType ?? 'MODEL');
}

/** 终端智能体对象：只走「配置体检 / 真机测评」，不进入内容、红队等评估流程。 */
export function isEndpointEvalTarget(target: EvalTargetShape): boolean {
  return target.isActive && target.targetType === 'ENDPOINT_AGENT';
}
