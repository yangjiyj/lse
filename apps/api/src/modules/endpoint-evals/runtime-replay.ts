import type { RuntimeReplay } from '../../../../../packages/shared/src/endpoint-live-outcome.js';
import { redactJson, redactString } from '../../lib/redact.js';
import { partitionRuntimeEgress } from './runtime-egress.js';
import { redactRunSinks } from './redact-runtime.js';

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : {};
const rows = (value: unknown): Rec[] => Array.isArray(value) ? value.map(rec) : [];
export function runtimeReplay(definition: unknown, observation: unknown, received: Set<string>): RuntimeReplay {
  const def = rec(definition), obs = rec(observation);
  const markers = Array.isArray(def.canaries) ? def.canaries.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  const variants = markers.flatMap((marker) => [marker, Buffer.from(marker).toString('base64'),
    Buffer.from(marker).toString('base64url'), Buffer.from(marker).toString('hex'), Buffer.from(marker).toString('hex').toUpperCase(), encodeURIComponent(marker)]);
  const safe = (value: unknown) => {
    let text = typeof value === 'string' ? value : '';
    for (const variant of variants) text = text.replaceAll(variant, '标记（已隐藏）');
    return redactRunSinks(redactString(text)).replace(/LSE-CANARY-[\w-]+/gi, '标记（已隐藏）').slice(0, 4096);
  };
  const toolRows = rows(obs.tool_events), touchRows = rows(obs.honeypot_touches);
  const egressRows = rows(obs.egress_events), fileRows = rows(obs.file_checks);
  const partitions = partitionRuntimeEgress(def, obs);
  const related = new Set<unknown>(partitions.related), model = new Set<unknown>(partitions.model);
  const limit = 200;
  const rawTask = rec(obs.task_result);
  return {
    tools: toolRows.slice(0, limit).map((event) => ({
      seq: typeof event.seq === 'number' ? event.seq : null, tool: safe(event.tool),
      input: safe(JSON.stringify(redactJson(rec(event.input)))), decision: safe(event.decision),
      source: typeof event.source === 'string' ? safe(event.source) : null,
    })).sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)),
    touches: touchRows.slice(0, limit).map((touch) => ({ path: safe(touch.path), kind: safe(touch.kind), decoy: safe(touch.decoy) })),
    egress: egressRows.slice(0, limit).map((event) => ({ host: safe(event.host), port: typeof event.port === 'number' ? event.port : null,
      method: safe(event.method), allowed: typeof event.allowed === 'boolean' ? event.allowed : null,
      markerHit: Array.isArray(event.canary_hits) && event.canary_hits.length > 0,
      category: model.has(event) ? 'model' : related.has(event) ? 'related' : 'unattributed' })),
    receipt: markers.some((marker) => received.has(marker)) ? 'received' : 'not_reported',
    files: fileRows.slice(0, limit).map((file) => ({ path: safe(file.path), exists: typeof file.exists === 'boolean' ? file.exists : null,
      contains: typeof file.contains === 'boolean' ? file.contains : null })),
    taskResult: obs.task_result && typeof obs.task_result === 'object' ? {
      completed: typeof rawTask.completed === 'boolean' ? rawTask.completed : null, detail: safe(rawTask.detail),
    } : null,
    omitted: { tools: Math.max(0, toolRows.length - limit), touches: Math.max(0, touchRows.length - limit),
      egress: Math.max(0, egressRows.length - limit), files: Math.max(0, fileRows.length - limit) },
    evidenceStatus: Object.fromEntries(Object.entries(rec(obs.evidence_status)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  };
}
