import {
  getServiceAssuranceLimitations,
  getServiceAssurancePlannedChecks,
  type ServiceAssuranceCheckExecution,
  type ServiceAssuranceMode,
  type ServiceAssuranceRunDetailResponse,
  type ServiceAssuranceTargetKind,
} from '@lse/shared';
import { z } from 'zod';
import { redactString } from '../../lib/redact.js';

export const EXECUTION_EVIDENCE_TYPE = 'CHECK_EXECUTION_V1';
export const REQUEST_TOTAL_EVIDENCE_TYPE = 'REQUEST_TOTAL_V1';
const requestTotalSchema = z
  .object({ requestCount: z.number().int().nonnegative().max(100_000).nullable() })
  .strict();
export function encodeRequestTotal(requestCount: number | null): string {
  return JSON.stringify(requestTotalSchema.parse({ requestCount }));
}
const executionCheckSchema = z
  .object({
    id: z.string().min(1).max(160),
    label: z.string().min(1).max(200),
    status: z.enum(['COMPLETED', 'FAILED', 'SKIPPED', 'UNKNOWN']),
    requestCount: z.number().int().nonnegative().max(100_000).nullable(),
    detail: z.string().max(2_000),
  })
  .strict();

export function encodeExecutionCheck(value: ServiceAssuranceCheckExecution): string {
  const parsed = executionCheckSchema.parse(value);
  return JSON.stringify({
    ...parsed,
    label: redactString(parsed.label),
    detail: redactString(parsed.detail),
  });
}

interface ExecutionEvidenceRow {
  evidenceType: string;
  ruleId: string | null;
  extractedValue: string | null;
}

export function readExecutionChecks(
  rows: ExecutionEvidenceRow[],
): ServiceAssuranceCheckExecution[] {
  return rows.flatMap((row) => {
    if (row.evidenceType !== EXECUTION_EVIDENCE_TYPE || !row.extractedValue) return [];
    try {
      const parsed = executionCheckSchema.parse(JSON.parse(row.extractedValue));
      if (parsed.id !== row.ruleId) return [];
      return [
        { ...parsed, label: redactString(parsed.label), detail: redactString(parsed.detail) },
      ];
    } catch {
      return [];
    }
  });
}

export function buildExecutionSummary(
  mode: ServiceAssuranceMode,
  targetKind: ServiceAssuranceTargetKind,
  rows: ExecutionEvidenceRow[],
): NonNullable<ServiceAssuranceRunDetailResponse['execution']> {
  const observed = readExecutionChecks(rows);
  const plan = getServiceAssurancePlannedChecks(mode, targetKind);
  const checks = plan.map((planned): ServiceAssuranceCheckExecution => {
    const matching = observed.filter((item) => item.id === planned.id);
    if (matching.length === 1) return { ...matching[0]!, label: planned.label };
    return {
      id: planned.id,
      label: planned.label,
      status: 'UNKNOWN',
      requestCount: null,
      detail: '未取得该检查项的完整执行记录，不能判断是否实际完成。',
    };
  });
  // Historical check IDs remain visible even after the current plan changes.
  for (const item of observed) {
    if (!plan.some((planned) => planned.id === item.id)) checks.push(item);
  }
  const totalRows = rows.filter((row) => row.evidenceType === REQUEST_TOTAL_EVIDENCE_TYPE);
  let recordedTotal: number | null = null;
  if (totalRows.length === 1) {
    try {
      recordedTotal = requestTotalSchema.parse(
        JSON.parse(totalRows[0]!.extractedValue ?? ''),
      ).requestCount;
    } catch {
      /* Corrupt totals remain unknown. */
    }
  }
  return {
    checks,
    requestCount:
      totalRows.length > 0
        ? recordedTotal
        : checks.length > 0 && checks.every((item) => item.requestCount !== null)
          ? checks.reduce((sum, item) => sum + item.requestCount!, 0)
          : null,
    telemetryAvailable: observed.length > 0,
    limitations: getServiceAssuranceLimitations(mode, targetKind),
  };
}
