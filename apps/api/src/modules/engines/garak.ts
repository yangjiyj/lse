import type { EngineResult, EngineRunResult } from '@lse/shared';
import { getJson, postJson } from './http.js';
import type { TaskLevelEngine, TaskScanContext } from './types.js';
import {
  asRecord,
  clip,
  coerceSeverity,
  firstArrayProp,
  firstStringProp,
  numOrNull,
} from './util.js';

// garak（NVIDIA，Apache-2.0）：开源大模型漏洞/红队探针扫描器。
// garak 本身是 Python CLI，无原生 REST，本产品用自研 FastAPI sidecar 包装为异步任务接口：
//   POST  {base}/scan        body {target:{base_url,api_key,model}, probes?, generations?, prompt_seeds?}
//                            → 200 {job_id}
//   GET   {base}/scan/{id}   → 200 {state:'running'|'done'|'failed', report?, message?}
// 任务级引擎：scan() 永不抛出；任何失败/超时降级为 SKIPPED，不连累主评估闭环。

export const GARAK_ENGINE = 'garak';

export interface GarakOptions {
  readonly baseUrl: string;
  /** garak 探针族；为空则交由 sidecar 使用其默认探针集。 */
  readonly probes?: string[];
  /** 每个探针的生成次数（越大越慢越准）。 */
  readonly generations?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
const SUBMIT_TIMEOUT_MS = 15000;
const POLL_TIMEOUT_MS = 10000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createGarakEngine(opts: GarakOptions): TaskLevelEngine {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return {
    engine: GARAK_ENGINE,
    async scan(ctx: TaskScanContext): Promise<EngineRunResult> {
      const startedAt = new Date();
      const deadline = startedAt.getTime() + ctx.timeoutMs;

      const skip = (errorMessage: string, raw: unknown = null): EngineRunResult => {
        const endedAt = new Date();
        return {
          engine: GARAK_ENGINE,
          taskId: ctx.taskId,
          status: 'SKIPPED',
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime(),
          rawOutput: raw,
          results: [],
          errorMessage,
        };
      };

      // 1) 提交扫描任务
      const submit = await postJson(
        `${base}/scan`,
        {
          target: {
            base_url: ctx.target.baseUrl,
            api_key: ctx.target.apiKey,
            model: ctx.target.model,
          },
          probes: opts.probes,
          generations: opts.generations,
          prompt_seeds: ctx.promptSeeds,
        },
        Math.min(ctx.timeoutMs, SUBMIT_TIMEOUT_MS),
      );
      if (!submit.ok) {
        return skip(submit.error ?? `提交 garak 扫描失败（HTTP ${submit.status}）`, submit.json);
      }
      const submitBody = asRecord(submit.json);
      const jobId = submitBody
        ? firstStringProp(submitBody, ['job_id', 'jobId', 'id', 'task_id'])
        : null;
      if (!jobId) {
        return skip('garak sidecar 未返回 job_id', submit.json);
      }

      // 2) 轮询直至 done / failed / 超时
      let report: unknown = null;
      for (;;) {
        if (Date.now() >= deadline) {
          return skip(`garak 扫描超时（>${ctx.timeoutMs}ms）`);
        }
        await delay(pollIntervalMs);
        const poll = await getJson(`${base}/scan/${encodeURIComponent(jobId)}`, POLL_TIMEOUT_MS);
        if (!poll.ok) {
          // 单次轮询失败不致命，继续重试直到超时
          continue;
        }
        const body = asRecord(poll.json);
        const state = body ? firstStringProp(body, ['state', 'status'])?.toLowerCase() : null;
        if (state === 'done' || state === 'completed' || state === 'success') {
          report = body?.report ?? body?.result ?? body?.data ?? body;
          break;
        }
        if (state === 'failed' || state === 'error') {
          const msg = body ? firstStringProp(body, ['message', 'error', 'reason']) : null;
          return skip(msg ?? 'garak 扫描执行失败', poll.json);
        }
        // running / pending → 继续轮询
      }

      const endedAt = new Date();
      const results = mapResults(
        ctx.taskId,
        report,
        startedAt.toISOString(),
        endedAt.toISOString(),
      );
      return {
        engine: GARAK_ENGINE,
        taskId: ctx.taskId,
        status: 'SUCCESS',
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        rawOutput: report,
        results,
      };
    },
  };
}

/** 判断一条探针记录是否「被绕过」（即风险项）。无法判定时保守按风险处理。 */
function isFailingProbe(r: Record<string, unknown>): boolean {
  const failed = numOrNull(r.failed ?? r.fail ?? r.hits ?? r.failures);
  if (failed !== null) return failed > 0;
  const rate = numOrNull(r.failure_rate ?? r.fail_rate ?? r.rate);
  if (rate !== null) return rate > 0;
  if (typeof r.passed === 'boolean') return r.passed === false;
  return true;
}

function mapResults(
  taskId: string,
  data: unknown,
  startedAt: string,
  endedAt: string,
): EngineResult[] {
  const passRecord = (evidence: string): EngineResult => ({
    engine: GARAK_ENGINE,
    taskId,
    questionId: null,
    status: 'success',
    riskCategory: 'redteam_probe',
    severity: 'INFO',
    score: null,
    verdict: 'PASS',
    evidence,
    rawOutput: data,
    startedAt,
    endedAt,
  });

  const root = asRecord(data);
  const arr =
    root !== null
      ? firstArrayProp(root, [
          'probes',
          'results',
          'findings',
          'vulnerabilities',
          'failures',
          'items',
        ])
      : Array.isArray(data)
        ? (data as unknown[])
        : null;

  if (arr === null || arr.length === 0) {
    return [passRecord('探针扫描完成，未解析到结构化结果')];
  }

  const findings: EngineResult[] = [];
  arr.forEach((item, i) => {
    const r = asRecord(item);
    if (r === null || !isFailingProbe(r)) return;

    const probe = firstStringProp(r, ['probe', 'category', 'type', 'name', 'rule', 'title']);
    const detector = firstStringProp(r, ['detector', 'check', 'detector_name']);
    const failed = numOrNull(r.failed ?? r.fail ?? r.hits ?? r.failures);
    const total = numOrNull(r.total ?? r.attempts ?? r.runs ?? r.generations);
    const rate = numOrNull(r.failure_rate ?? r.fail_rate ?? r.rate);

    const evidenceParts: string[] = [];
    if (probe) evidenceParts.push(`探针 ${probe}`);
    if (detector) evidenceParts.push(`检测器 ${detector}`);
    if (failed !== null && total !== null) {
      evidenceParts.push(`${failed}/${total} 次越狱成功`);
    } else if (rate !== null) {
      evidenceParts.push(`失败率 ${(rate * 100).toFixed(0)}%`);
    }
    const evidence =
      evidenceParts.length > 0 ? evidenceParts.join('，') : clip(JSON.stringify(item));

    findings.push({
      engine: GARAK_ENGINE,
      taskId,
      questionId: null,
      status: 'success',
      riskCategory: probe ?? `garak_probe_${i + 1}`,
      severity: coerceSeverity(r.severity ?? r.risk ?? r.level ?? r.riskLevel ?? rate, 'HIGH'),
      score: rate ?? numOrNull(r.score ?? r.confidence),
      verdict: 'FAIL',
      evidence: clip(evidence),
      rawOutput: item,
      startedAt,
      endedAt,
    });
  });

  if (findings.length === 0) {
    return [passRecord(`探针扫描完成，共 ${arr.length} 个探针均未被绕过`)];
  }
  return findings;
}
