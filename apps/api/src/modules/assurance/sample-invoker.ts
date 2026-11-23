import { chatComplete } from '../../lib/llm-client.js';
import type { AssuranceSamplePlanItem } from './types.js';
import type { AssuranceSampleInvocationResult } from './runner.js';
import type { ChatMessage } from '@lse/shared';

export interface GatewayAssuranceRuntimeTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function invokeGatewayAssuranceSample(
  target: GatewayAssuranceRuntimeTarget,
  sample: AssuranceSamplePlanItem,
): Promise<AssuranceSampleInvocationResult> {
  const startedAt = Date.now();
  const cfg = {
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    model: target.model,
    extraHeaders: {
      'X-LSE-Eval-Run-Id': sample.evalRunId,
      'X-LSE-Task-Id': sample.taskId,
      'X-LSE-Sample-Id': sample.sampleId,
      'X-LSE-Target-Id': sample.targetId,
      'X-LSE-Trace-Id': sample.traceId,
    },
    defaultParams: { stream: false },
  };
  const turns = sample.turns?.length
    ? sample.turns
    : [{ role: 'user' as const, content: sample.prompt }];
  const messages: ChatMessage[] = [];
  const turnResults: NonNullable<AssuranceSampleInvocationResult['turns']> = [];
  let finalStatus = 'SUCCESS';
  let finalHttpStatus: number | null = 200;
  let finalError: string | null = null;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    messages.push({ role: 'user', content: turn.content });
    const result = await chatComplete(cfg, messages, {
      timeoutMs: 60_000,
      temperature: 0,
      maxTokens: 32,
    });
    turnResults.push({
      turnIndex: index + 1,
      status: result.status,
      httpStatus: result.httpStatus,
      error: result.error,
      latencyMs: result.latencyMs || 0,
    });
    finalStatus = result.status;
    finalHttpStatus = result.httpStatus;
    finalError = result.error;
    if (result.content) {
      messages.push({ role: 'assistant', content: result.content });
    }
    if (result.status !== 'SUCCESS') break;
  }
  return {
    status: finalStatus,
    httpStatus: finalHttpStatus,
    error: finalError,
    latencyMs: turnResults.reduce((sum, item) => sum + item.latencyMs, 0) || Date.now() - startedAt,
    turnCount: turns.length,
    turns: turnResults,
  };
}
