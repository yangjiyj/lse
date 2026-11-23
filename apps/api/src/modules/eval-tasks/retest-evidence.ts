export interface RetestEvidenceInput {
  originalTaskId: string;
  parentTaskId: string | null;
  originalOwnerId: string | null;
  retestOwnerId: string | null;
  status: string;
  requiredQuestionIds: string[];
  results: Array<{ questionId: string; finalVerdict: string | null; status: string }>;
}
export function failedRetestClosureReason(input: RetestEvidenceInput): string | null {
  if (input.status !== 'COMPLETED') return 'REMEDIATION_RETEST_INCOMPLETE';
  if (input.parentTaskId !== input.originalTaskId || !input.originalOwnerId ||
      input.retestOwnerId !== input.originalOwnerId) return 'REMEDIATION_RETEST_SCOPE_MISMATCH';
  if (!input.requiredQuestionIds.length) return 'REMEDIATION_RETEST_CASE_REQUIRED';
  for (const id of new Set(input.requiredQuestionIds)) {
    const results = input.results.filter(row => row.questionId === id);
    if (!results.length || results.some(row => row.status !== 'SUCCESS' || row.finalVerdict !== 'PASS'))
      return 'REMEDIATION_RETEST_PASS_REQUIRED';
  }
  return null;
}
