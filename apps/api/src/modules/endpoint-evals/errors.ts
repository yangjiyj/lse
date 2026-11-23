import { LIVE_EVAL_BLOCKED_REASONS } from '../../../../../packages/shared/src/fleet-live-eval.js';
import { redactJson } from '../../lib/redact.js';
import type { EndpointEvalResult } from './config.js';

export function endpointErrorDetail(error: unknown): string {
  const values =
    typeof error === 'string'
      ? [error]
      : error && typeof error === 'object'
        ? ['code', 'message', 'detail', 'reason', 'stderr'].flatMap((key) => {
            const value = (error as Record<string, unknown>)[key];
            return typeof value === 'string' ? [value] : [];
          })
        : [];
  return String(redactJson(values.filter(Boolean).map((v) => LIVE_EVAL_BLOCKED_REASONS[v] ?? v).join('：'))).slice(0, 4096);
}

/** 智能体输出流里「调用模型失败、正在重试」的状态码（服务端错误和限流）；少于 3 次视为偶发，返回空。 */
function modelApiFailureStatuses(transcript: string): number[] {
  const statuses: number[] = [];
  for (const line of transcript.split('\n')) {
    if (!line.includes('api_retry')) continue;
    try {
      const value = JSON.parse(line);
      const status = Number(value?.error_status);
      if (value?.subtype === 'api_retry' && (status >= 500 || status === 429)) statuses.push(status);
    } catch {
      /* 不是 JSON 行，跳过 */
    }
  }
  return statuses.length >= 3 ? [...new Set(statuses)].sort((a, b) => a - b) : [];
}

export function scenarioErrorDetail(scenario: EndpointEvalResult['scenarios'][number]): string {
  if (scenario.status !== 'completed') {
    const statuses = modelApiFailureStatuses(scenario.transcript_excerpt ?? '');
    if (statuses.length) return `模型接口持续报错（${statuses.join('、')}），智能体没能正常运行。请检查模型服务后重测。`;
  }
  if (scenario.error_code && LIVE_EVAL_BLOCKED_REASONS[scenario.error_code]) return LIVE_EVAL_BLOCKED_REASONS[scenario.error_code]!;
  if (scenario.status === 'timeout') return '超时';
  if (scenario.status !== 'error') return '';
  for (const text of [scenario.final_text, scenario.transcript_excerpt]) {
    for (const line of text.split('\n')) {
      try {
        const value = JSON.parse(line);
        const code = value?.error?.code ?? value?.code;
        if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(code)) return code;
      } catch {
        const code = line.match(/^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?=$|[:：\s])/);
        if (code) return code[1]!;
      }
    }
  }
  return '执行出错';
}
