import type { ChatMessage, LlmCallResult, LlmTargetConfig } from '@lse/shared';
import { config } from '../../config.js';
import { chatComplete, type ChatCompleteOptions } from '../../lib/llm-client.js';
import { resolveServerTargetEgressContext } from '../../lib/target-egress-policy.js';
import {
  pickJudgeTarget,
  selectLatestActiveJudgeTarget,
  type JudgeTargetStore,
  type SutRef,
} from '../engines/judge-target.js';

/** 评估模型调用器（默认 chatComplete，测试可注入）。 */
export type RagChatCaller = (
  cfg: LlmTargetConfig,
  messages: ChatMessage[],
  opts?: ChatCompleteOptions,
) => Promise<LlmCallResult>;

export interface ResolvedJudge {
  config: LlmTargetConfig;
  /** 展示用名称：平台设置里的判定模型名，或环境变量来源。 */
  name: string;
  source: 'judge_target' | 'env';
}

function envJudge(): ResolvedJudge | null {
  const baseUrl = config.LLM_JUDGE_BASE_URL.trim();
  const apiKey = config.LLM_JUDGE_API_KEY.trim();
  const model = config.LLM_JUDGE_MODEL.trim();
  if (!baseUrl || !apiKey || !model) return null;
  return {
    config: { baseUrl, apiKey, model, egressContext: resolveServerTargetEgressContext() },
    name: `${model}（环境变量 LLM_JUDGE_*）`,
    source: 'env',
  };
}

/**
 * 解析评估模型：复用 eval-tasks 判定链路的同一来源——平台设置中启用的 JUDGE 评估对象优先，
 * 未配置 JUDGE 行时回退环境变量 LLM_JUDGE_*。传入 sut 时强制「评估模型 ≠ 被测对象」。
 * 返回 null 表示未配置（或与被测对象相同），调用方必须明确提示，不得伪造结果。
 */
export async function resolveRagJudge(
  store: JudgeTargetStore,
  sut?: SutRef,
  /** platformOnly：只取平台的模型（没有归属租户的任务用） */
  opts: { platformOnly?: boolean } = {},
): Promise<ResolvedJudge | null> {
  const selected = await selectLatestActiveJudgeTarget(store, opts);
  if (!selected.found) return envJudge();
  if (!selected.target) return null;
  const picked = sut
    ? pickJudgeTarget(selected.target, sut)
    : pickJudgeTarget(selected.target, { id: '', baseUrl: '', model: '' });
  if (!picked) return null;
  return {
    config: { ...picked, egressContext: resolveServerTargetEgressContext() },
    name: selected.target.name,
    source: 'judge_target',
  };
}

export const RAG_JUDGE_NOT_CONFIGURED_MESSAGE =
  '未配置评估模型：请在“平台设置 → 独立判定模型”中启用独立的评估模型（或在“评估对象”中新建类型为判定模型的对象，或配置 LLM_JUDGE_* 环境变量）后再操作。';

/** 前端跳转到评估模型配置位置。 */
export const RAG_JUDGE_SETTINGS_PATH = '/settings#independent-judge-model';

/** 从模型输出中提取第一个 JSON 对象（兼容 ```json 代码块与前后多余文字）。 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter((v): v is string => typeof v === 'string');
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

export type JsonCallResult =
  | { ok: true; json: Record<string, unknown>; raw: string }
  | { ok: false; error: string };

/** 调用评估模型并要求 JSON 输出；网络错误与解析失败都归一化为 ok:false。 */
export async function callJudgeJson(
  chat: RagChatCaller,
  judge: ResolvedJudge,
  messages: ChatMessage[],
  opts: { seed?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<JsonCallResult> {
  const cfg: LlmTargetConfig =
    opts.seed === undefined
      ? judge.config
      : {
          ...judge.config,
          defaultParams: { ...(judge.config.defaultParams ?? {}), seed: opts.seed },
        };
  const res = await chat(cfg, messages, {
    temperature: 0,
    timeoutMs: opts.timeoutMs ?? 60_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (res.status !== 'SUCCESS') return { ok: false, error: res.error ?? '评估模型调用失败' };
  const json = extractJsonObject(res.content);
  if (!json) return { ok: false, error: '评估模型未返回可解析的 JSON' };
  return { ok: true, json, raw: res.content };
}

export function str(v: unknown, max = 4000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function num01(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}
