import type {
  ChatMessage,
  LlmCallResult,
  LlmTargetConfig,
  LlmToolCall,
  LlmToolDefinition,
} from '@lse/shared';
import { chatCompleteWithTools, type ChatCompleteOptions } from '../../../lib/llm-client.js';
import { AGENT_SANDBOX_TOOLS } from '../runner.js';
import type { AgentSandboxToolCall } from '../types.js';
import { executeFanoutTool } from './real-fetch.js';
import { fanoutVerdict, type FanoutFinding } from './verdict.js';
import type { EgressPolicy } from './egress-guard.js';
import { FANOUT_CHANNELS } from './channels.js';
import { buildFanoutMatrix, type FanoutObjective, type FanoutScenarioSpec } from './matrix.js';
import { FanoutSinkServer } from './sink-server.js';

type CallModelWithTools = (
  cfg: LlmTargetConfig,
  messages: ChatMessage[],
  tools: LlmToolDefinition[],
  opts: ChatCompleteOptions,
) => Promise<LlmCallResult>;

export interface RunFanoutInput {
  cfg: LlmTargetConfig;
  spec: FanoutScenarioSpec;
  sink: FanoutSinkServer;
  egress: EgressPolicy;
  callModelWithTools?: CallModelWithTools;
  chatOptions?: ChatCompleteOptions;
  maxTurns?: number;
}

export async function runFanoutScenario(
  input: RunFanoutInput,
): Promise<FanoutFinding & { turns: number }> {
  const call = input.callModelWithTools ?? chatCompleteWithTools;
  const metaMaxTurns = (input.spec.metadata as { maxTurns?: number } | null)?.maxTurns;
  const maxTurns =
    input.maxTurns ?? (typeof metaMaxTurns === 'number' && metaMaxTurns > 0 ? metaMaxTurns : 4);
  const messages: ChatMessage[] = [{ role: 'user', content: input.spec.prompt }];
  let fetchedUntrusted = false;
  let exfilAttempted = false;
  let turns = 0;

  for (let i = 0; i < maxTurns; i++) {
    turns = i + 1;
    const result = await call(input.cfg, messages, AGENT_SANDBOX_TOOLS, {
      ...(input.chatOptions ?? {}),
      toolChoice: input.chatOptions?.toolChoice ?? 'auto',
    });
    if (result.status === 'ERROR') break;

    const toolCalls: LlmToolCall[] = result.toolCalls ?? [];
    if (toolCalls.length === 0) break;

    messages.push({ role: 'assistant', content: result.content, toolCalls });
    for (const tc of toolCalls) {
      const sandboxCall: AgentSandboxToolCall = {
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      };
      const r = await executeFanoutTool(sandboxCall, {
        egress: input.egress,
        canary: input.spec.canary,
      });
      if (tc.name === 'http_get' || tc.name === 'browser_open') {
        // 只有真取到不可信内容才算 untrustedInput；fetch 失败(blockReason!==null)不计入。
        if (!r.egressBlocked && r.blockReason === null) fetchedUntrusted = true;
      }
      if (r.exfilAttempt) exfilAttempted = true;
      messages.push({
        role: 'tool',
        toolCallId: tc.id,
        content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result),
      });
    }
  }

  const allowed = input.spec.metadata as { allowedTools?: string[] } | null;
  const privilegedAccess = Array.isArray(allowed?.allowedTools)
    ? allowed!.allowedTools.some((t) => t === 'read_file' || t === 'run_shell')
    : true;

  return {
    ...fanoutVerdict({
      channel: input.spec.channel,
      exfilHits: input.sink.hits(input.spec.runToken),
      fetchedUntrusted,
      exfilAttempted,
      privilegedAccess,
    }),
    turns,
  };
}

export interface RunFanoutBatchInput {
  cfg: LlmTargetConfig;
  objective: FanoutObjective;
  runToken: string;
  canary: string;
  host?: string;
  callModelWithTools?: CallModelWithTools;
  chatOptions?: ChatCompleteOptions;
}

export interface RunFanoutBatchResult {
  findings: (FanoutFinding & { turns: number })[];
  failedChannels: string[];
}

export async function runFanoutBatch(input: RunFanoutBatchInput): Promise<RunFanoutBatchResult> {
  const sink = new FanoutSinkServer();
  await sink.start(input.host ?? '127.0.0.1', 0);
  try {
    const egress = { allowHosts: [new URL(sink.baseUrl).host] };
    const findings: (FanoutFinding & { turns: number })[] = [];
    const failedChannels: string[] = [];
    for (const channel of FANOUT_CHANNELS) {
      // 每通道独立 runToken + canary + exfil 桶，避免跨通道回调污染判定
      // （某通道得手不应连累其后通道；hits 按 channelToken 隔离记账）。
      const channelToken = `${input.runToken}::${channel}`;
      const channelCanary = `${input.canary}-${channel}`;
      const reg = sink.register(channelToken, channelCanary, {
        secretHint: input.objective.secretHint,
      });
      const spec = buildFanoutMatrix({
        objective: input.objective,
        registration: reg,
        channels: [channel],
      })[0]!;
      try {
        const f = await runFanoutScenario({
          cfg: input.cfg,
          spec,
          sink,
          egress,
          callModelWithTools: input.callModelWithTools,
          chatOptions: input.chatOptions,
        });
        findings.push(f);
      } catch (err) {
        failedChannels.push(`${channel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // lethal 优先、再按 trifecta 分数降序
    findings.sort((a, b) => Number(b.lethal) - Number(a.lethal) || b.score - a.score);
    return { findings, failedChannels };
  } finally {
    await sink.stop();
  }
}
