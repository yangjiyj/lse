import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { validateSample } from '../endpoint-evals/samples/registry.js';
import {
  RUNTIME_CHANNELS, RUNTIME_HARMS, RUNTIME_TEMPLATES, RUNTIME_VECTORS,
  type RuntimeSample,
} from '../../../../../packages/shared/src/runtime-eval.js';

const text = z.string().min(1).max(8192);
const danger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read_decoy'), decoy: text }).strict(),
  z.object({ kind: z.literal('egress_to'), host: text }).strict(),
  z.object({ kind: z.literal('sink_received') }).strict(),
  z.object({ kind: z.literal('cmd_matches'), pattern: text }).strict(),
  z.object({ kind: z.literal('path_changed'), path: text, op: z.enum(['delete', 'modify', 'create']) }).strict(),
  z.object({ kind: z.literal('wrote_text'), path: text, contains: text }).strict(),
]);
const tool = z.object({ name: text, description: text, input_schema: z.record(z.unknown()), result: z.unknown() }).strict();
const server = z.object({ name: text, kind: z.enum(['poisoned_description', 'poisoned_result', 'rug_pull', 'shadow_tool', 'benign']),
  tools: z.array(tool).max(8), mutate_after_calls: z.number().int().min(0).optional(), poison: text }).strict();
const sampleSchema = z.object({
  id: z.string().min(1).max(200), vector: z.enum(RUNTIME_VECTORS), channel: z.enum(RUNTIME_CHANNELS).optional(),
  title: text, prompt: text, turns: z.array(text).max(4).optional(),
  template: z.union([z.enum(RUNTIME_TEMPLATES), z.literal('any')]), slots: z.record(z.string().max(8192)),
  decoys: z.object({ workspace: z.array(text).max(4), home: z.array(text).max(8) }).strict(),
  harm: z.enum(RUNTIME_HARMS), danger: z.array(danger).min(1).max(20),
  expect: z.object({ final_contains: z.array(text).max(20).optional(),
    files: z.array(z.object({ path: text, contains: text }).strict()).max(20).optional(),
    run: z.array(text).max(8).optional() }).strict().optional(),
  mcp: z.object({ servers: z.array(server).max(4) }).strict().optional(), explain: text, refs: z.array(text).max(3), clauseIds: z.array(text).max(4).optional(),
  origin: z.string().trim().max(200).optional(),
}).strict();

function simulatedTarget(value: string): boolean {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      ['.invalid', '.example', '.test'].some((suffix) => url.hostname.toLowerCase().endsWith(suffix));
  } catch { return false; }
}

export function parseCustomSample(input: unknown): RuntimeSample {
  const sample = sampleSchema.parse(input) as RuntimeSample;
  if (!sample.origin) delete sample.origin;
  if (Buffer.byteLength(JSON.stringify(sample), 'utf8') > 16 * 1024) throw badRequest('样本内容超过 16 KiB');
  const problems = validateSample(sample);
  const visible = [sample.prompt, ...(sample.turns ?? []), ...Object.values(sample.slots), JSON.stringify(sample.mcp ?? {})];
  const urls = visible.flatMap((value) => value.match(/https?:\/\/[^\s"'<>\\]+/gi) ?? []);
  for (const value of urls) {
    if (!simulatedTarget(value)) problems.push('外部地址只能使用不可达的仿真域名或受控接收端占位符');
  }
  for (const entry of sample.danger) if (entry.kind === 'egress_to' && entry.host !== '{{SINK}}') {
    if (!simulatedTarget(entry.host)) problems.push('外发目标只能使用不可达的仿真域名或受控接收端占位符');
  }
  if (problems.length) throw badRequest(problems.join('；'));
  return sample;
}
