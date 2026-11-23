import type { EngineResult, JudgeInput } from '@lse/shared';
import { postJson } from './http.js';
import { asRecord, clip, coerceSeverity, numOrNull } from './util.js';
import type { PerQuestionEngine } from './types.js';

export const PYTHON_JUDGE_ENGINE = 'python-judge';

export interface PythonJudgeOptions {
  baseUrl: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20000;

function skipResult(input: JudgeInput, startedAt: string, reason: string): EngineResult {
  return {
    engine: PYTHON_JUDGE_ENGINE,
    taskId: input.taskId,
    questionId: input.questionId,
    status: 'skipped',
    riskCategory: 'python_judge_unavailable',
    severity: 'INFO',
    score: null,
    verdict: 'UNKNOWN',
    evidence: reason,
    rawOutput: { skipped: true, reason },
    startedAt,
    endedAt: new Date().toISOString(),
  };
}

/**
 * 外部 Python 判定 sidecar（封装 llm-guard 等开源扫描器）的单题引擎适配器。
 * 不可用 / 超时 / 非法响应 → 返回 status='skipped'，绝不抛出，保证主闭环不被拖垮。
 *
 * 约定接口：POST {baseUrl}/scan
 *   请求 { prompt, response, question_type, should_refuse }
 *   响应 { flagged: boolean, risk_category?: string, severity?: string|number, score?: number, evidence?: string, ... }
 */
export function createPythonJudgeEngine(opts: PythonJudgeOptions): PerQuestionEngine {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    engine: PYTHON_JUDGE_ENGINE,
    async judge(input: JudgeInput): Promise<EngineResult> {
      const startedAt = new Date().toISOString();
      const res = await postJson(
        `${base}/scan`,
        {
          prompt: input.prompt,
          response: input.response,
          question_type: input.questionType,
          should_refuse: input.shouldRefuse,
        },
        timeoutMs,
      );
      if (!res.ok || res.json === null) {
        return skipResult(input, startedAt, res.error ?? 'sidecar 返回空响应');
      }
      const body = asRecord(res.json);
      if (body === null) {
        return skipResult(input, startedAt, 'sidecar 返回非对象 JSON');
      }
      const flagged = body.flagged === true;
      const severity = coerceSeverity(body.severity, flagged ? 'HIGH' : 'INFO');
      const evidenceRaw = typeof body.evidence === 'string' ? body.evidence : '';
      const category =
        typeof body.risk_category === 'string' && body.risk_category.length > 0
          ? body.risk_category
          : 'llm_guard_scan';
      return {
        engine: PYTHON_JUDGE_ENGINE,
        taskId: input.taskId,
        questionId: input.questionId,
        status: 'success',
        riskCategory: category,
        severity: flagged ? severity : 'INFO',
        score: numOrNull(body.score),
        verdict: flagged ? 'FAIL' : 'PASS',
        evidence: evidenceRaw.length > 0 ? clip(evidenceRaw) : null,
        rawOutput: res.json,
        startedAt,
        endedAt: new Date().toISOString(),
      };
    },
  };
}
