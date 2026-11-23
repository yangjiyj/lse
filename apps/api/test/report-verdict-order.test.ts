import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Verdict } from '@lse/shared';
import type { ReportEvalResult, ReportInputData } from '../src/modules/reports/report-builder.js';
import { buildSpecializedReport } from '../src/modules/reports/specialized/index.js';
import {
  assertReportConclusionSnapshotsMatch,
  buildReportListSummary,
} from '../src/modules/reports/report-list-summary.js';

const now = new Date('2026-10-30T08:22:09.000Z');

function result(id: string, verdict: Verdict): ReportEvalResult {
  return {
    id,
    finalVerdict: verdict,
    status: 'SUCCESS',
    question: {
      content: '检查项 ' + id,
      type: 'GENERAL',
      shouldRefuse: false,
      language: 'zh',
      severity: 'HIGH',
      category: 'endpoint',
    },
  };
}

function endpointData(results: ReportEvalResult[]): ReportInputData {
  const verdictCounts: Record<string, number> = {};
  for (const r of results) {
    if (r.finalVerdict) verdictCounts[r.finalVerdict] = (verdictCounts[r.finalVerdict] ?? 0) + 1;
  }
  return {
    task: {
      id: 'endpoint-order-task',
      name: 'demo-host 配置体检',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['endpoint-agent-eval'],
      totalQuestions: results.length,
      processedQuestions: results.length,
      passedCount: verdictCounts.PASS ?? 0,
      failedCount: verdictCounts.FAIL ?? 0,
      errorCount: verdictCounts.ERROR ?? 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: 'demo-host（Linux）', provider: 'jiandun-fleet', model: 'endpoint', targetType: 'ENDPOINT_AGENT' },
      questionSets: [],
    },
    verdictCounts,
    results,
    findings: [],
    engineRuns: [],
    wrongAnswers: [],
    generatedAt: now,
  } as unknown as ReportInputData;
}

test('终端报告：结果首条为 FAIL 时判定分布顺序与结论快照一致，报告可生成', () => {
  // 现网 3078b730 的真实顺序：FAIL、UNKNOWN×2、PASS×2、UNKNOWN×3、FAIL×2
  const verdicts: Verdict[] = ['FAIL', 'UNKNOWN', 'UNKNOWN', 'PASS', 'PASS', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'FAIL', 'FAIL'];
  const data = endpointData(verdicts.map((v, i) => result('r' + i, v)));
  const built = buildSpecializedReport('comprehensive', data);
  const list = buildReportListSummary(built.summary as never);
  assert.doesNotThrow(() =>
    assertReportConclusionSnapshotsMatch(built.summary, list, built.kind, built.passRate),
  );
  assert.deepEqual(Object.keys(built.summary.verdictDistribution), ['PASS', 'FAIL', 'UNKNOWN']);
});
