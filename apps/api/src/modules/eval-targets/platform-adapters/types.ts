export interface ObservedToolCall {
  name: string;
  kind: 'tool' | 'knowledge' | 'http' | 'code' | 'workflow_node' | 'plugin' | 'unknown';
  arguments: Record<string, unknown>;
  result?: string;
  status?: 'success' | 'error';
  raw?: unknown;
}
export interface PlatformTurnResult {
  text: string;
  toolCalls: ObservedToolCall[];
  conversationId: string | null;
  latencyMs: number;
  usage?: { promptTokens?: number; completionTokens?: number };
  error?: { code: string; message: string };
}
export interface PlatformAdapter {
  sendTurn(input: { message: string; conversationId: string | null; signal?: AbortSignal }): Promise<PlatformTurnResult>;
  diagnose(): Promise<{ ok: boolean; detail: string }>;
}
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
