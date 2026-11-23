import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { prisma } from '../../db.js';

// 批量评估完成回调（3.6(5) 系统对接）：计划完成（含失败终止）后向注册的
// callbackUrl POST 结果摘要。P0 修复（2026-10-02）：
//  - select 缺 id 却使用 plan.id（payload 中 planId 恒为 undefined）
//  - 新增稳定 event_id（幂等键，接收端据此去重）
//  - 新增 HMAC-SHA256 投递签名（LSE_BATCH_CALLBACK_SECRET + KEY_ID），
//    覆盖 timestamp + body，接收端可防伪造/重放
//  持久投递状态/DLQ/对账仍属后续阶段；重试仍为 3 次退避。
const CALLBACK_ATTEMPTS = 3;
const CALLBACK_TIMEOUT_MS = 10_000;

export interface BatchCallbackPayload {
  event: 'batch_evaluation.completed';
  event_id: string;
  planId: string;
  name: string;
  status: string;
  stopReason: string | null;
  finishedAt: string | null;
  report: {
    total: number;
    pass: number;
    fail: number;
    incomplete: number;
  } | null;
}

export function callbackSecret(): string | null {
  const secret = process.env.LSE_BATCH_CALLBACK_SECRET?.trim();
  return secret ? secret : null;
}

export function callbackKeyId(): string {
  return process.env.LSE_BATCH_CALLBACK_KEY_ID?.trim() || 'lse-batch-callback-v1';
}

/** 签名覆盖 `${timestamp}.${rawBody}`；接收端必须在时间窗内校验以防重放。 */
export function signCallbackPayload(secret: string, keyId: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', `${keyId}.${secret}`).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyCallbackSignature(secret: string, keyId: string, timestamp: string, rawBody: string, signature: string): boolean {
  const expected = signCallbackPayload(secret, keyId, timestamp, rawBody);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function backoff(attempt: number): number {
  return Math.min(30_000, 2 ** attempt * 1_000);
}

export function summarizeCallbackRuns(runs: Array<{ status: string; results: Array<{ verdict: string | null }> }>) {
  const fail = runs.filter(run => run.results.some(result => result.verdict === 'FAIL')).length;
  const pass = runs.filter(run => run.status === 'COMPLETED' && run.results.length > 0 &&
    run.results.every(result => result.verdict === 'PASS')).length;
  return { total: runs.length, pass, fail, incomplete: runs.length - pass - fail };
}

export async function notifyBatchCallback(planId: string): Promise<void> {
  const plan = await prisma.batchEvaluation.findUnique({
    where: { id: planId },
    select: {
      id: true,
      callbackUrl: true,
      name: true,
      status: true,
      stopReason: true,
      finishedAt: true,
      runs: { select: { status: true, results: { select: { verdict: true } } } },
    },
  });
  if (!plan?.callbackUrl) return;
  const runs = plan.runs;
  const payload: BatchCallbackPayload = {
    event: 'batch_evaluation.completed',
    event_id: `batch_evaluation.completed:${plan.id}`,
    planId: plan.id,
    name: plan.name,
    status: plan.status,
    stopReason: plan.stopReason,
    finishedAt: plan.finishedAt ? plan.finishedAt.toISOString() : null,
    report: runs.length ? summarizeCallbackRuns(runs) : null,
  };
  const rawBody = JSON.stringify(payload);
  const secret = callbackSecret();
  const keyId = callbackKeyId();
  for (let attempt = 0; attempt < CALLBACK_ATTEMPTS; attempt++) {
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-lse-event-id': payload.event_id,
      };
      if (secret) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        headers['x-lse-key-id'] = keyId;
        headers['x-lse-timestamp'] = timestamp;
        headers['x-lse-signature'] = signCallbackPayload(secret, keyId, timestamp, rawBody);
      }
      const response = await fetch(plan.callbackUrl, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      if (response.ok) return;
    } catch {
      // 网络失败按重试处理
    }
    if (attempt < CALLBACK_ATTEMPTS - 1)
      await new Promise((resolve) => setTimeout(resolve, backoff(attempt)));
  }
}
