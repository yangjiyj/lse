export const OPENVEX_NOT_AFFECTED_JUSTIFICATIONS = [
  'component_not_present',
  'vulnerable_code_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
] as const;

export type OpenVexNotAffectedJustification = (typeof OPENVEX_NOT_AFFECTED_JUSTIFICATIONS)[number];

const JUSTIFICATION_LABELS: Record<OpenVexNotAffectedJustification, string> = {
  component_not_present: '目标中不存在该组件',
  vulnerable_code_not_present: '组件中不包含易受影响代码',
  vulnerable_code_not_in_execute_path: '易受影响代码不在可执行路径',
  vulnerable_code_cannot_be_controlled_by_adversary: '攻击者无法控制易受影响代码',
  inline_mitigations_already_exist: '已有不可绕过的缓解措施',
};

function requireStatement(statement: string): string {
  const normalized = statement.trim();
  if (normalized.length === 0) throw new Error('必须填写可审计说明');
  if (normalized.length > 1000) throw new Error('说明不得超过 1000 个字符');
  return normalized;
}

export function buildNotAffectedDecision(input: {
  justification: OpenVexNotAffectedJustification;
  statement: string;
}) {
  if (!OPENVEX_NOT_AFFECTED_JUSTIFICATIONS.includes(input.justification)) {
    throw new Error('不受影响理由不在受控范围内');
  }
  const statement = requireStatement(input.statement);
  return {
    impactStatus: 'NOT_AFFECTED' as const,
    justification: input.justification,
    reason: `${JUSTIFICATION_LABELS[input.justification]}：${statement}`,
  };
}

interface OriginalAssuranceRun {
  id: string;
  taskId: string | null;
}

interface RetestAssuranceRun {
  id: string;
  taskId: string | null;
  retestOfRunId: string | null;
  status: string;
  coverageStatus: string;
  endedAt: Date | null;
  /** Only the original risk, not other findings from the same run. */
  remainingAffectedCount: number;
  originalRiskCheckCompleted: boolean;
}

export function buildFixedDecision(input: {
  originalRun: OriginalAssuranceRun;
  retestRun: RetestAssuranceRun;
  statement: string;
}) {
  const { originalRun, retestRun } = input;
  const successfulRetest =
    retestRun.id !== originalRun.id &&
    retestRun.taskId === originalRun.taskId &&
    retestRun.retestOfRunId === originalRun.id &&
    ['COMPLETED', 'PARTIAL'].includes(retestRun.status) &&
    retestRun.originalRiskCheckCompleted &&
    retestRun.endedAt instanceof Date &&
    !Number.isNaN(retestRun.endedAt.getTime()) &&
    retestRun.remainingAffectedCount === 0;

  if (!successfulRetest) {
    throw new Error('复测必须关联原运行，并证明原问题对应的检查已完成且问题未再出现');
  }

  return {
    impactStatus: 'FIXED' as const,
    fixedByRunId: retestRun.id,
    reason: requireStatement(input.statement),
  };
}
