import { createHash } from 'node:crypto';
import { z } from 'zod';
import { redactJson, redactString, sanitizeJson } from '../../lib/redact.js';
import {
  analyzeAgentRisk,
  clip,
  DESTRUCTIVE_TOOL_RE,
  EXFIL_TOOL_RE,
  INTERNAL_HOST_RE,
  NETWORK_TOOL_RE,
  READ_SENSITIVE_TOOL_RE,
  SENSITIVE_TARGET_RE,
} from '../gateway-logs/agent-analysis.js';
import type {
  ConversationMessage,
  GatewayAuditEvent,
  ToolCallEvent,
} from '../gateway-logs/client.js';

// ADR Sensor 通常会一次导出多个会话；上限主要由路由 bodyLimit 约束，这里再限制会话数防止滥用。
const MAX_ENTRIES = 500;
const MAX_MESSAGES_PER_ENTRY = 2_000;
const MAX_MESSAGES_PER_SESSION = 10_000;
const MAX_TOOLS_PER_MESSAGE = 512;
const MAX_TEXT_LENGTH = 64 * 1024;

const adrToolSchema = z.object({
  tool_name: z.string().trim().min(1).max(256),
  tool_type: z.string().trim().max(128).optional().default(''),
  server_name: z.string().trim().max(256).nullish(),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
  result: z.string().max(MAX_TEXT_LENGTH).nullish(),
  status: z.string().trim().max(64).nullish(),
  error: z.string().max(MAX_TEXT_LENGTH).nullish(),
});

const adrMessageSchema = z.object({
  role: z.string().trim().min(1).max(64),
  content: z.string().max(MAX_TEXT_LENGTH).optional().default(''),
  tools: z.array(adrToolSchema).max(MAX_TOOLS_PER_MESSAGE).optional().default([]),
  sequence_id: z.string().trim().max(256).nullish(),
});

const adrEventSchema = z.object({
  timestamp: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((value) => Number.isFinite(Date.parse(value)), 'ADR timestamp 必须是有效时间'),
  source: z.string().trim().min(1).max(64),
  session_id: z.string().trim().min(1).max(512),
  chat_history: z.array(adrMessageSchema).max(MAX_MESSAGES_PER_ENTRY).optional().default([]),
  model: z.string().trim().max(256).nullish(),
  uuid: z.string().trim().max(256).nullish(),
  is_chunked: z.boolean().optional().default(false),
  total_chunks: z.number().int().positive().nullish(),
  chunk_sequence: z.number().int().nonnegative().nullish(),
  is_truncated: z.boolean().optional().default(false),
});

const canarySchema = z.array(z.string().trim().min(1).max(512)).max(32).optional().default([]);
const adrExportSchema = z.object({
  entries: z.array(adrEventSchema).min(1).max(MAX_ENTRIES),
  canaries: canarySchema,
  includeEvidenceExcerpts: z.boolean().optional().default(false),
});
const adrArraySchema = z.array(adrEventSchema).min(1).max(MAX_ENTRIES);

type AdrEvent = z.infer<typeof adrEventSchema>;
type AdrTool = z.infer<typeof adrToolSchema>;

export interface AdrImportFinding {
  engine: 'adr-sensor-import';
  riskCategory: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  score: number | null;
  verdict: 'FAIL' | 'UNKNOWN';
  title: string;
  evidence: string;
  detail: Record<string, unknown>;
}

export interface AdrImportSessionPreview {
  eventId: string;
  source: string;
  sessionFingerprint: string;
  timestamp: string;
  model: string | null;
  messageCount: number;
  toolCallCount: number;
  chunked: boolean;
  truncated: boolean;
  findings: AdrImportFinding[];
}

export interface AdrImportPreview {
  source: 'adr_sensor';
  persisted: false;
  entryCount: number;
  messageCount: number;
  toolCallCount: number;
  findingCount: number;
  sessions: AdrImportSessionPreview[];
}

interface ParsedPayload {
  entries: AdrEvent[];
  canaries: string[];
  includeEvidenceExcerpts: boolean;
}

export interface AdrPreviewOptions {
  /** 持久化场景应强制为 false，避免把客户完整提示词或回复写入 LSE。 */
  includeEvidenceExcerpts?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown): ParsedPayload {
  if (Array.isArray(value)) {
    return {
      entries: adrArraySchema.parse(value),
      canaries: [],
      includeEvidenceExcerpts: false,
    };
  }
  if (isRecord(value) && Array.isArray(value.entries)) {
    const parsed = adrExportSchema.parse(value);
    return {
      entries: parsed.entries,
      canaries: parsed.canaries,
      includeEvidenceExcerpts: parsed.includeEvidenceExcerpts,
    };
  }
  return {
    entries: [adrEventSchema.parse(value)],
    canaries: [],
    includeEvidenceExcerpts: false,
  };
}

function fingerprint(source: string, sessionId: string): string {
  return createHash('sha256').update(`${source}\u0000${sessionId}`).digest('hex').slice(0, 24);
}

/**
 * Sensor 会把超长会话拆成多个 event。分析前仅在内存中按原始 session_id 合并，
 * 这样跨 chunk 的读敏感数据 → 后续外发仍能被同一条轨迹识别；合并后立刻只保留匿名指纹。
 */
function coalesceChunkedEntries(entries: AdrEvent[]): AdrEvent[] {
  const groups = new Map<string, Array<{ entry: AdrEvent; inputIndex: number }>>();
  const output: Array<{ entry: AdrEvent; inputIndex: number }> = [];

  entries.forEach((entry, inputIndex) => {
    if (!entry.is_chunked) {
      output.push({ entry, inputIndex });
      return;
    }
    const key = `${entry.source}\u0000${entry.session_id}`;
    const group = groups.get(key) ?? [];
    group.push({ entry, inputIndex });
    groups.set(key, group);
  });

  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        (left.entry.chunk_sequence ?? left.inputIndex) -
        (right.entry.chunk_sequence ?? right.inputIndex),
    );
    const first = group[0]!;
    const declaredChunks = Math.max(0, ...group.map(({ entry }) => entry.total_chunks ?? 0));
    const sequenceCount = new Set(
      group.flatMap(({ entry }) =>
        entry.chunk_sequence === null || entry.chunk_sequence === undefined
          ? []
          : [entry.chunk_sequence],
      ),
    ).size;
    const allMessages = group.flatMap(({ entry }) => entry.chat_history);
    output.push({
      inputIndex: first.inputIndex,
      entry: {
        ...first.entry,
        chat_history: allMessages.slice(0, MAX_MESSAGES_PER_SESSION),
        model: group.find(({ entry }) => Boolean(entry.model))?.entry.model ?? first.entry.model,
        is_chunked: true,
        total_chunks: declaredChunks || group.length,
        chunk_sequence: 0,
        is_truncated:
          group.some(({ entry }) => entry.is_truncated) ||
          allMessages.length > MAX_MESSAGES_PER_SESSION ||
          (declaredChunks > 0 && sequenceCount > 0 && sequenceCount < declaredChunks),
      },
    });
  }

  return output.sort((left, right) => left.inputIndex - right.inputIndex).map(({ entry }) => entry);
}

const TARGET_KEYS = new Set([
  'url',
  'uri',
  'target',
  'destination',
  'endpoint',
  'host',
  'path',
  'file',
  'filename',
  'command',
  'cmd',
  'script',
]);

function findTarget(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTarget(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (!isRecord(value)) return '';
  for (const [key, item] of Object.entries(value)) {
    if (TARGET_KEYS.has(key.toLowerCase()) && typeof item === 'string' && item.trim()) {
      return item.trim();
    }
  }
  for (const item of Object.values(value)) {
    const found = findTarget(item, depth + 1);
    if (found) return found;
  }
  return '';
}

const DESTRUCTIVE_ARGUMENT_RE =
  /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm\s+-[^\n]*r[^\n]*f|mkfs(?:\.|\s)|shutdown\b|reboot\b|poweroff\b|format\s+[a-z]:|del\s+\/[sq]|drop\s+(?:table|database)|truncate\s+table)|remove-item[^\n]*(?:-recurse|-force)/i;

function inferRiskLevel(toolName: string, normalizedTarget: string): string {
  if (DESTRUCTIVE_TOOL_RE.test(toolName) && DESTRUCTIVE_ARGUMENT_RE.test(normalizedTarget)) {
    return 'critical';
  }
  if (EXFIL_TOOL_RE.test(toolName)) return 'high';
  if (NETWORK_TOOL_RE.test(toolName) && INTERNAL_HOST_RE.test(normalizedTarget)) return 'high';
  if (READ_SENSITIVE_TOOL_RE.test(toolName) && SENSITIVE_TARGET_RE.test(normalizedTarget)) {
    return 'high';
  }
  return 'low';
}

function redactedText(value: unknown): string {
  const redacted = redactJson(value);
  if (typeof redacted === 'string') return clip(redacted);
  try {
    return clip(JSON.stringify(redacted));
  } catch {
    return '';
  }
}

function normalizeStatus(tool: AdrTool): string {
  const status = (tool.status ?? '').trim().toLowerCase();
  if (status) return status;
  if (tool.error) return 'error';
  if (tool.result !== null && tool.result !== undefined) return 'success';
  return '';
}

function toToolCall(tool: AdrTool, source: string): ToolCallEvent {
  const rawTarget = findTarget(tool.arguments);
  const normalizedTarget = redactString(rawTarget, 'normalizedTarget');
  const status = normalizeStatus(tool);
  const blocked = ['blocked', 'denied', 'rejected'].includes(status);
  return {
    toolName: tool.tool_name,
    toolType: tool.tool_type,
    riskLevel: inferRiskLevel(tool.tool_name, normalizedTarget),
    status,
    effectiveDecision: blocked ? 'block' : 'observe',
    normalizedTarget,
    provenance: `adr_sensor:${source}`,
    tainted: false,
    taintedArguments: '',
    matchedPolicyName: '',
    matchReason: '',
    parameters: redactedText(tool.arguments),
    result: redactedText(tool.result ?? tool.error ?? ''),
  };
}

function toGatewayEvent(event: AdrEvent): {
  event: GatewayAuditEvent;
  fingerprint: string;
  messageCount: number;
  toolCallCount: number;
} {
  const sessionFingerprint = fingerprint(event.source, event.session_id);
  const messages: ConversationMessage[] = event.chat_history.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const tools = event.chat_history.flatMap((message) =>
    message.tools.map((tool) => toToolCall(tool, event.source)),
  );
  return {
    fingerprint: sessionFingerprint,
    messageCount: messages.length,
    toolCallCount: tools.length,
    event: {
      id: `adr-${sessionFingerprint}`,
      requestId: sessionFingerprint,
      createdAt: new Date(event.timestamp).toISOString(),
      correlation: {},
      source: { clientId: sessionFingerprint, agentType: event.source },
      target: event.model ? { model: event.model } : {},
      metrics: { messageCount: messages.length, toolCallCount: tools.length },
      action: 'observe',
      verdict: 'unreviewed',
      riskLevel: 'unknown',
      policyHits: [],
      evidence: {
        redacted: true,
        securityEventCount: 0,
        rawContentAvailable: messages.length > 0,
      },
      messages,
      toolCalls: tools,
    },
  };
}

function sanitizeFinding(
  finding: ReturnType<typeof analyzeAgentRisk>[number],
  includeEvidenceExcerpts: boolean,
): AdrImportFinding {
  const detail = (sanitizeJson(finding.detail) ?? {}) as Record<string, unknown>;
  if (!includeEvidenceExcerpts) {
    delete detail.promptExcerpt;
    delete detail.responseExcerpt;
  }
  return {
    engine: 'adr-sensor-import',
    riskCategory: finding.riskCategory,
    severity: finding.severity,
    score: finding.score,
    verdict: finding.verdict,
    title: redactString(finding.title),
    evidence: redactString(finding.evidence),
    detail,
  };
}

/**
 * ADR Sensor 导入预览：只在请求内存中归一和分析，不写数据库、不保存完整对话。
 * 用户名、主机名、项目路径、原始日志路径等 ADR 端点元数据不进入返回结构。
 */
export function previewAdrPayload(
  value: unknown,
  options: AdrPreviewOptions = {},
): AdrImportPreview {
  const payload = parsePayload(value);
  const includeEvidenceExcerpts =
    options.includeEvidenceExcerpts ?? payload.includeEvidenceExcerpts;
  const entries = coalesceChunkedEntries(payload.entries);
  const sessions = entries.map((entry): AdrImportSessionPreview => {
    const normalized = toGatewayEvent(entry);
    const findings = analyzeAgentRisk(normalized.event, payload.canaries).map((finding) =>
      sanitizeFinding(finding, includeEvidenceExcerpts),
    );
    return {
      eventId: normalized.event.id,
      source: entry.source,
      sessionFingerprint: normalized.fingerprint,
      timestamp: normalized.event.createdAt,
      model: entry.model ? redactString(entry.model) : null,
      messageCount: normalized.messageCount,
      toolCallCount: normalized.toolCallCount,
      chunked: entry.is_chunked,
      truncated: entry.is_truncated,
      findings,
    };
  });
  return {
    source: 'adr_sensor',
    persisted: false,
    entryCount: sessions.length,
    messageCount: sessions.reduce((sum, item) => sum + item.messageCount, 0),
    toolCallCount: sessions.reduce((sum, item) => sum + item.toolCallCount, 0),
    findingCount: sessions.reduce((sum, item) => sum + item.findings.length, 0),
    sessions,
  };
}
