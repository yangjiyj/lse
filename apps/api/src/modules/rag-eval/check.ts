import { readJsonPath } from '@lse/shared';
import { chatComplete } from '../../lib/llm-client.js';
import type { EvaluationTargetConfig } from '../eval-targets/invoker.js';
import type { RagOptions } from './options.js';
import type { RagChatCaller, ResolvedJudge } from './judge-model.js';
import { askRagTarget, extractContext, readEntries, retrieveFromTarget } from './target-client.js';

export interface ProbeCheck {
  key: string;
  label: string;
  status: 'pass' | 'fail' | 'unconfigured';
  reason: string;
}

/** 只返回固定中文原因，不将上游正文、地址或凭据带回浏览器。 */
function failureReason(status: number | null | undefined, error = '', raw?: unknown): string {
  if (status === 401) return '认证失败，请检查应用 API Key。';
  if (status === 403) return '接口拒绝访问，请检查应用或模型权限。';
  if (status === 404) return '接口不存在，请检查应用地址和接口路径。';
  if (/timeout|超时|abort/i.test(error)) return '请求超时，请检查服务状态后重试。';
  if (typeof raw === 'string' && /^\s*(<!doctype|<html)/i.test(raw)) return '接口返回了 HTML 页面，请填写应用 API 地址。';
  if (status && status >= 400) return `接口返回 HTTP ${status}，请检查应用服务配置。`;
  if (/出站|允许|内网|禁止|拒绝/.test(error)) return '出站访问被拒绝，请联系管理员核对目标地址允许清单。';
  if (status && status < 400) return '回答 JSON 路径取不到文本，请核对响应字段配置。';
  return '无法连接服务，请检查应用地址、端口及网络。';
}

/** 无平台数据写入、无评估额度扣减；只向目标发送一句“你好”，不调用上传和删除接口。 */
export async function checkRagTarget(
  target: EvaluationTargetConfig,
  rag: RagOptions,
  configChecks: Array<{ key: string; label: string; ok: boolean; required: boolean; hint: string }>,
) {
  const started = Date.now();
  const checks: ProbeCheck[] = configChecks.map(c => ({
    key: `config.${c.key}`, label: c.label,
    status: c.ok ? 'pass' : c.required ? 'fail' : 'unconfigured', reason: c.ok ? '' : c.hint,
  }));
  if (configChecks.some(c => c.required && !c.ok)) return { ok: false, httpStatus: null, latencyMs: 0, checks };
  const answer = await askRagTarget(target, rag, '你好', { timeoutMs: 10_000 });
  const access = target.accessConfig as { responseTextPath?: string } | null;
  const path = access?.responseTextPath;
  const value = path ? readJsonPath(answer.raw, path) : answer.content;
  const answerOk = answer.status === 'SUCCESS' && typeof value === 'string' && Boolean(value.trim());
  checks.push({ key: 'answer', label: '应用连接与回答抽取', status: answerOk ? 'pass' : 'fail',
    reason: answerOk ? '' : failureReason(answer.httpStatus, answer.error ?? '', answer.raw) });
  for (const [key, label, configured, entries] of [
    ['context', '检索片段', rag.contextPath, extractContext(answer.raw, rag)],
    ['citations', '引用来源', rag.citationPath, readEntries(answer.raw, rag.citationPath, rag.citationTextField, rag.citationIdField)],
  ] as const) {
    const extracted = entries?.some(e => Boolean(e.text?.trim() || e.id));
    checks.push({ key, label, status: !configured ? 'unconfigured' : entries === null ? 'fail' : extracted ? 'pass' : 'unconfigured',
      reason: !configured ? '未配置路径，可在高级设置中补充。' : entries === null ? '配置的 JSON 路径取不到片段，请核对响应字段。' : extracted ? '' : '本次未返回片段；请用知识库内问题复核检索效果。' });
  }
  if (rag.retrieval) {
    const r = await retrieveFromTarget(target, rag, rag.retrieval, '你好', { timeoutMs: 10_000 });
    checks.push({ key: 'retrieval', label: '检索接口', status: r.ok ? 'pass' : 'fail',
      reason: r.ok ? '' : failureReason(Number(r.error.match(/HTTP (\d+)/)?.[1]) || null, r.error) });
  } else checks.push({ key: 'retrieval', label: '检索接口', status: 'unconfigured', reason: '未配置独立检索接口；可使用应用问答评估。' });
  return { ok: checks.every(c => c.status !== 'fail'), httpStatus: answer.httpStatus ?? null, latencyMs: Date.now() - started, checks };
}

/** 对同一判定模型执行最小调用；不使用“已配置”冒充可用。 */
export async function checkRagJudge(judge: ResolvedJudge | null, chat: RagChatCaller = chatComplete) {
  if (!judge) return { available: false, message: '判定模型当前不可用：未配置独立判定模型。' };
  try {
    const r = await chat(judge.config, [{ role: 'user', content: '只回复好' }], { maxTokens: 8, temperature: 0, timeoutMs: 10_000 });
    const available = r.status === 'SUCCESS' && Boolean(r.content?.trim());
    return { available, message: available ? null : `判定模型当前不可用：${failureReason(r.httpStatus, r.error ?? '')}` };
  } catch (err) {
    return { available: false, message: `判定模型当前不可用：${failureReason(null, err instanceof Error ? err.name : '')}` };
  }
}
