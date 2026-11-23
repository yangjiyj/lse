import type { AgentSandboxToolCall } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonArguments(value: unknown): {
  arguments: Record<string, unknown>;
  rawArguments?: unknown;
  parseError?: 'invalid_json_arguments' | 'non_object_arguments';
} {
  if (typeof value !== 'string') {
    return isRecord(value)
      ? { arguments: value }
      : { arguments: {}, rawArguments: value, parseError: 'non_object_arguments' };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed)
      ? { arguments: parsed }
      : { arguments: {}, rawArguments: value, parseError: 'non_object_arguments' };
  } catch {
    return { arguments: {}, rawArguments: value, parseError: 'invalid_json_arguments' };
  }
}

function normalizeSingleToolCall(value: unknown): AgentSandboxToolCall | null {
  if (!isRecord(value)) return null;

  const fn = isRecord(value.function) ? value.function : null;
  const name =
    typeof fn?.name === 'string'
      ? fn.name
      : typeof value.name === 'string'
        ? value.name
        : typeof value.tool === 'string'
          ? value.tool
          : null;
  if (name === null) return null;

  let argsValue: unknown = {};
  if (fn !== null && 'arguments' in fn) argsValue = fn.arguments;
  else if ('arguments' in value) argsValue = value.arguments;
  else if ('args' in value) argsValue = value.args;

  const parsed = parseJsonArguments(argsValue);
  const normalized: AgentSandboxToolCall = {
    name,
    arguments: parsed.arguments,
    raw: undefined,
  };
  if (typeof value.id === 'string') normalized.id = value.id;
  if (parsed.rawArguments !== undefined) normalized.rawArguments = parsed.rawArguments;
  if (parsed.parseError !== undefined) normalized.parseError = parsed.parseError;
  return normalized;
}

function extractToolCallsContainer(output: unknown): unknown[] {
  if (!isRecord(output)) return [];
  if (Array.isArray(output.tool_calls)) return output.tool_calls;
  if (isRecord(output.message) && Array.isArray(output.message.tool_calls)) {
    return output.message.tool_calls;
  }
  if (
    typeof output.tool === 'string' ||
    typeof output.name === 'string' ||
    isRecord(output.function)
  ) {
    return [output];
  }
  if (Array.isArray(output.choices)) {
    return output.choices.flatMap((choice) => {
      if (!isRecord(choice) || !isRecord(choice.message)) return [];
      return Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
    });
  }
  if (Array.isArray(output.tools)) return output.tools;
  return [];
}

function fencedJsonPayload(text: string): string | null {
  const fenced = text.match(/^```(?:json|tool_call|tool_calls)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced?.[1] !== undefined) return fenced[1].trim();
  const prefixed = text.match(/^tool_calls?\s*:\s*([\s\S]+)$/i);
  return prefixed?.[1]?.trim() ?? null;
}

function parseFallbackText(text: string): AgentSandboxToolCall[] {
  const trimmed = text.trim();
  const payload =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ? trimmed
      : fencedJsonPayload(trimmed);
  if (payload === null) return [];

  try {
    const parsed = JSON.parse(payload) as unknown;
    const structured = extractToolCallsContainer(parsed)
      .map(normalizeSingleToolCall)
      .filter((call): call is AgentSandboxToolCall => call !== null);
    if (structured.length > 0) return structured;

    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values
      .map(normalizeSingleToolCall)
      .filter((call): call is AgentSandboxToolCall => call !== null);
  } catch {
    return [];
  }
}

function extractFallbackTexts(output: unknown): string[] {
  if (typeof output === 'string') return [output];
  if (!isRecord(output)) return [];

  const texts: string[] = [];
  if (typeof output.content === 'string') texts.push(output.content);
  if (isRecord(output.message) && typeof output.message.content === 'string') {
    texts.push(output.message.content);
  }
  if (Array.isArray(output.choices)) {
    for (const choice of output.choices) {
      if (
        isRecord(choice) &&
        isRecord(choice.message) &&
        typeof choice.message.content === 'string'
      ) {
        texts.push(choice.message.content);
      }
    }
  }
  return texts;
}

export function parseToolCallsFromModelOutput(output: unknown): AgentSandboxToolCall[] {
  const structured = extractToolCallsContainer(output)
    .map(normalizeSingleToolCall)
    .filter((call): call is AgentSandboxToolCall => call !== null);
  if (structured.length > 0) return structured;

  for (const text of extractFallbackTexts(output)) {
    const calls = parseFallbackText(text);
    if (calls.length > 0) return calls;
  }

  return [];
}
