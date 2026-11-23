import type { ServiceAssuranceRunDetailResponse } from '@lse/shared';
import { getServiceAssuranceLimitations } from '@lse/shared';

const CHECK_STATUS = {
  COMPLETED: '已完成',
  FAILED: '执行失败',
  SKIPPED: '已跳过',
  UNKNOWN: '无法确认',
} as const;

export function AssuranceExecutionSummary({
  detail,
}: {
  detail: ServiceAssuranceRunDetailResponse;
}) {
  const { run, execution } = detail;
  const running = run.status === 'PENDING' || run.status === 'RUNNING';
  const limits = execution?.limitations ?? getServiceAssuranceLimitations(run.mode, run.targetKind);
  const hasTelemetry = execution?.telemetryAvailable === true;
  const counts = execution?.checks.reduce(
    (result, check) => {
      result[check.status] += 1;
      return result;
    },
    { COMPLETED: 0, FAILED: 0, SKIPPED: 0, UNKNOWN: 0 },
  );
  return (
    <section
      aria-label="本次执行与覆盖"
      className="min-w-0 rounded-md border border-line bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-ink">本次执行与覆盖</h2>
      <p className="mt-1 break-all text-sm text-ink-2">
        {run.targetName}
        {run.targetAddress ? ' · ' + run.targetAddress : ''}
      </p>
      {run.mode !== 'SBOM' && (
        <p className="mt-1 text-xs leading-5 text-ink-3">当前页面新建核验不携带访问凭据。</p>
      )}
      {!hasTelemetry ? (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
          {running
            ? '执行数据尚在采集中，完成后将显示实际检查项目和覆盖情况。'
            : '该记录未采集完整执行数据，无法确认实际检查项目或请求数量，不能将零条风险解释为完整检查通过。'}
        </p>
      ) : (
        <p className="mt-3 text-sm leading-6 text-ink-2">
          检查项目/步骤：完成 {counts?.COMPLETED ?? 0}，失败 {counts?.FAILED ?? 0}，跳过{' '}
          {counts?.SKIPPED ?? 0}，无法确认 {counts?.UNKNOWN ?? 0}。 请求数量：
          {execution?.requestCount === null || execution?.requestCount === undefined
            ? '未采集'
            : execution.requestCount}
          。
        </p>
      )}
      {!!execution?.checks.length && (
        <ul className="mt-3 divide-y divide-slate-100">
          {execution.checks.map((check) => (
            <li key={check.id} className="py-2 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium text-ink">{check.label}</span>
                <span className={check.status === 'COMPLETED' ? 'text-ink-3' : 'text-amber-800'}>
                  {CHECK_STATUS[check.status]}
                </span>
              </div>
              <p className="mt-1 break-words text-xs leading-5 text-ink-3">{check.detail}</p>
              {check.requestCount !== null && (
                <p className="mt-1 text-xs text-ink-3">请求数量：{check.requestCount}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {!!limits.length && (
        <div className="mt-3 border-t border-slate-100 pt-3 text-xs leading-5 text-ink-3">
          <h3 className="font-semibold">覆盖限制</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
