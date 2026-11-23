import { computeFrameworkCoverage, type FrameworkCoverageRow } from '../frameworks/coverage.js';

interface Warnable {
  warn: (obj: unknown, msg?: string) => void;
}

/** 框架覆盖行只保留约定字段，不把页面展开用的附加信息写进报告快照。 */
export function toSnapshotRow(row: FrameworkCoverageRow): FrameworkCoverageRow {
  return {
    framework: row.framework,
    entryId: row.entryId,
    entryName: row.entryName,
    tested: row.tested,
    passed: row.passed,
    failed: row.failed,
    undetermined: row.undetermined,
    status: row.status,
    sampleAdequate: row.sampleAdequate,
    ...(row.note ? { note: row.note } : {}),
  };
}

/**
 * 生成报告时按该任务范围计算框架覆盖矩阵并写入 summary.frameworkCoverage（只加字段）。
 * 计算失败时降级为不写，绝不让报告生成失败。
 */
export async function attachFrameworkCoverage(
  summary: { frameworkCoverage?: FrameworkCoverageRow[] },
  taskId: string,
  log?: Warnable,
  compute: (scope: {
    taskId: string;
  }) => Promise<{ rows: FrameworkCoverageRow[] }> = computeFrameworkCoverage,
): Promise<void> {
  try {
    const coverage = await compute({ taskId });
    if (coverage.rows.length > 0) summary.frameworkCoverage = coverage.rows.map(toSnapshotRow);
  } catch (err) {
    log?.warn({ err }, 'framework coverage failed; report is generated without it');
  }
}
