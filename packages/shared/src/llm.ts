// LLM 调用相关的通用类型契约：被 apps/api（连接测试）与 apps/worker（评估执行器）复用。

export interface LlmToolCall {
  id?: string;
  type?: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: unknown;
  parseError?: 'invalid_json_arguments' | 'non_object_arguments';
  raw?: unknown;
}

export interface LlmToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type LlmToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

/** OpenAI 兼容多模态内容片段（W6b 多模态越狱）。 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * 多模态（OpenAI 兼容）内容数组；存在时序列化为 content 数组并覆盖 content 字符串。
   * content 字符串仍保留纯文本部分，供日志、判定与不支持多模态的路径使用。
   */
  contentParts?: ChatContentPart[];
  /** OpenAI-compatible tool response id; serialized as tool_call_id. */
  toolCallId?: string;
  /** Optional tool name for provider compatibility and debugging. */
  name?: string;
  /** Assistant tool calls to preserve multi-turn OpenAI-compatible protocol. */
  toolCalls?: LlmToolCall[];
}

export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export type LlmCallStatus = 'SUCCESS' | 'ERROR';

/** OpenAI 兼容调用的目标配置（由 ModelTarget 派生，仅取调用所需字段）。 */
export interface LlmTargetConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string> | null;
  defaultParams?: Record<string, unknown> | null;
  /** Server-owned egress scope used for target URL validation. */
  egressContext?: { tenantId: string; projectId: string };
}

/** 归一化的单次模型调用结果：用于连接测试，并在 M5 落库到 eval_results。 */
export interface LlmCallResult {
  status: LlmCallStatus;
  /** 助手回复文本；出错时为空串。 */
  content: string;
  finishReason: string | null;
  /** 响应回显的模型名。 */
  model: string | null;
  usage: LlmUsage;
  latencyMs: number;
  httpStatus: number | null;
  /** 人类可读错误信息；成功时为 null。 */
  error: string | null;
  /** 原始响应 JSON 或错误负载，便于排查与留证。 */
  raw: unknown;
  /** OpenAI-compatible tool_calls, parsed into normalized function calls when present. */
  toolCalls?: LlmToolCall[];
}
