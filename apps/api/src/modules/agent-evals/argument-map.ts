import { z } from 'zod';

const sourcePath = z.string().min(1).max(128).refine(value => {
  const parts = value.split('.');
  return parts.length <= 4 && parts.every(part => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(part) &&
    !['__proto__', 'prototype', 'constructor'].includes(part));
});
export const simulatorArgumentMapSchema = z.record(z.enum(['url', 'path', 'command', 'data']),
  z.object({ source: sourcePath, format: z.enum(['string', 'shell_argv']).default('string') }).strict())
  .refine(value => Object.keys(value).length <= 4);
export type SimulatorArgumentMap = z.infer<typeof simulatorArgumentMapSchema>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function validateArgumentMap(parameters: Record<string, unknown>, map?: SimulatorArgumentMap): void {
  for (const [destination, entry] of Object.entries(map ?? {})) {
    let node: Record<string, unknown> | null = parameters;
    for (const part of entry.source.split('.')) {
      const properties: Record<string, unknown> | null = record(node?.properties);
      node = properties && Object.prototype.hasOwnProperty.call(properties, part) ? record(properties[part]) : null;
      if (!node) throw new Error('Argument map source must be a declared schema leaf.');
    }
    if (entry.format === 'shell_argv') {
      if (destination !== 'command' || node?.type !== 'array' || record(node.items)?.type !== 'string')
        throw new Error('Shell argv mapping requires a declared string array.');
    } else if (node?.type !== 'string') {
      throw new Error('String mapping requires a declared string leaf.');
    }
  }
}

export function normalizeSimulatorArguments(original: Record<string, unknown>, map?: SimulatorArgumentMap): Record<string, unknown> {
  const serialized = JSON.stringify(original);
  if (Buffer.byteLength(serialized) > 65536) throw new Error('Argument map input exceeds its bound.');
  const normalized = { ...original };
  for (const [destination, entry] of Object.entries(map ?? {})) {
    let value: unknown = original;
    for (const part of entry.source.split('.')) {
      const current = record(value);
      if (!current || !Object.prototype.hasOwnProperty.call(current, part)) throw new Error('Argument map source is missing.');
      value = current[part];
    }
    if (entry.format === 'shell_argv') {
      if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === 'string') ||
        !['sh', 'bash', '/bin/sh', '/bin/bash'].includes(value[0] ?? '') || !['-c', '-lc'].includes(value[1] ?? ''))
        throw new Error('Unsupported native shell argv shape.');
      value = value[2];
    }
    if (typeof value !== 'string' || Buffer.byteLength(value) > 16384) throw new Error('Mapped argument is not a bounded string.');
    if (entry.source !== destination && Object.prototype.hasOwnProperty.call(original, destination) && original[destination] !== value)
      throw new Error('Native and simulator arguments conflict.');
    normalized[destination] = value;
  }
  return normalized;
}
