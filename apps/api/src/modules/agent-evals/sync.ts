import { createHash } from 'node:crypto';
import type { AgentAttackPack, Prisma, PrismaClient } from '@prisma/client';

export type AgentAttackPackSource = {
  id: string;
  name: string;
  sourceUrl: string;
  manifestUrl: string;
  sourceRefs: string[];
};

export type AgentAttackPackLintResult = {
  status: 'PASS' | 'FAIL';
  errors: string[];
};

export type AgentAttackPackAsyncFetchResult = { manifest: unknown };

export type AgentAttackPackFetcher = (
  source: AgentAttackPackSource,
) => Promise<AgentAttackPackAsyncFetchResult> | unknown;

type AgentAttackPackPrisma = Pick<PrismaClient, 'agentAttackPack'>;

type JsonCompatible =
  | string
  | number
  | boolean
  | null
  | JsonCompatible[]
  | { [key: string]: JsonCompatible };

export type AgentAttackPackSyncResult = {
  source: AgentAttackPackSource;
  lint: AgentAttackPackLintResult;
  pack: AgentAttackPack;
};

export const AGENT_ATTACK_PACK_SOURCES: AgentAttackPackSource[] = [
  {
    id: 'agentdojo',
    name: 'AgentDojo',
    sourceUrl: 'https://github.com/ethz-spylab/agentdojo',
    manifestUrl: 'https://github.com/ethz-spylab/agentdojo',
    sourceRefs: ['https://github.com/ethz-spylab/agentdojo'],
  },
  {
    id: 'toolemu',
    name: 'ToolEmu',
    sourceUrl: 'https://github.com/ryoungj/ToolEmu',
    manifestUrl: 'https://github.com/ryoungj/ToolEmu',
    sourceRefs: ['https://github.com/ryoungj/ToolEmu'],
  },
  {
    id: 'promptfoo-agents-red-team',
    name: 'Promptfoo Agents Red Team',
    sourceUrl: 'https://www.promptfoo.dev/docs/red-team/agents/',
    manifestUrl: 'https://www.promptfoo.dev/docs/red-team/agents/',
    sourceRefs: ['https://www.promptfoo.dev/docs/red-team/agents/'],
  },
  {
    id: 'rampart',
    name: 'RAMPART',
    sourceUrl: 'https://microsoft.github.io/RAMPART/',
    manifestUrl: 'https://microsoft.github.io/RAMPART/',
    sourceRefs: ['https://microsoft.github.io/RAMPART/'],
  },
];

const DANGEROUS_FIELD_NAMES = new Set([
  'childprocess',
  'cmd',
  'command',
  'commands',
  'exec',
  'execute',
  'hook',
  'hooks',
  'install',
  'npmscript',
  'npmscripts',
  'ossystem',
  'postinstall',
  'postsync',
  'preinstall',
  'presync',
  'run',
  'runshell',
  'script',
  'scripts',
  'setup',
  'shell',
  'subprocess',
]);

const DANGEROUS_TEXT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'shell script shebang',
    pattern: /^#!.*\b(?:bash|sh|zsh|fish|python|node|powershell|pwsh)\b/im,
  },
  {
    label: 'curl or wget piped to shell',
    pattern: /\b(?:curl|wget)\b[\s\S]{0,200}\|\s*(?:(?:\/usr)?\/bin\/)?(?:bash|sh|zsh)\b/i,
  },
  {
    label: 'curl or wget followed by shell execution',
    pattern: /\b(?:curl|wget)\b[\s\S]{0,300}(?:;|&&)\s*(?:(?:\/usr)?\/bin\/)?(?:bash|sh|zsh)\b/i,
  },
  { label: 'rm -rf', pattern: /\brm\s+-[a-z]*r[a-z]*f\b|\brm\s+-[a-z]*f[a-z]*r\b/i },
  { label: 'chmod 777', pattern: /\bchmod\s+777\b/i },
  { label: 'child_process', pattern: /\bchild_process\b/i },
  { label: 'subprocess', pattern: /\bsubprocess\b/i },
  { label: 'os.system', pattern: /\bos\.system\s*\(/i },
  { label: 'process execution API', pattern: /\b(?:exec|execFile|spawn|fork)\s*\(/i },
  {
    label: 'shell command execution',
    pattern: /(?:^|[\s;|&])(?:(?:\/usr)?\/bin\/)?(?:bash|sh|zsh|powershell|pwsh)\s+-c\b/i,
  },
  { label: 'node -e', pattern: /\bnode\s+-e\b/i },
  { label: 'python -c', pattern: /\bpython(?:\d+(?:\.\d+)?)?\s+-c\b/i },
  { label: 'cmd /c', pattern: /\bcmd(?:\.exe)?\s*\/c\b/i },
  {
    label: 'powershell -Command',
    pattern: /\b(?:powershell|pwsh)\s+-(?:command|encodedcommand)\b/i,
  },
  {
    label: 'package manager run/install',
    pattern: /\b(?:npm|pnpm|yarn)\s+(?:run|install|add|exec|dlx)\b/i,
  },
];

function normalizeSourceUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveAgentAttackPackSource(sourceIdOrUrl: string): AgentAttackPackSource {
  const input = sourceIdOrUrl.trim();
  const normalizedInputUrl = normalizeSourceUrl(input);
  const source = AGENT_ATTACK_PACK_SOURCES.find(
    (candidate) =>
      candidate.id === input || normalizeSourceUrl(candidate.sourceUrl) === normalizedInputUrl,
  );
  if (!source) {
    throw new Error(`Source ${sourceIdOrUrl} is not an allowed agent attack pack source`);
  }
  return source;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function compareCodePointKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isArrayIndexKey(key: string): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) {
    return false;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < 4294967295;
}

function arrayLengthFromDescriptors(descriptors: {
  [key: string]: PropertyDescriptor | undefined;
}): number {
  const length = descriptors.length;
  if (!length || !('value' in length) || typeof length.value !== 'number') {
    return 0;
  }
  return Number.isSafeInteger(length.value) && length.value > 0 ? length.value : 0;
}

function topLevelString(manifest: unknown, key: string): string | null {
  if (!isRecord(manifest)) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(manifest, key);
  if (!descriptor || !('value' in descriptor)) {
    return null;
  }
  return optionalString(descriptor.value);
}

function readAsyncFetchedManifest(fetched: unknown): unknown {
  if (!isRecord(fetched)) {
    throw new Error(
      'Async agent attack pack fetchers must resolve an object envelope: { manifest }',
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(fetched, 'manifest');
  if (!descriptor || !('value' in descriptor)) {
    throw new Error(
      'Async agent attack pack fetchers must resolve an object envelope: { manifest }',
    );
  }
  return descriptor.value;
}

function sanitizeForJson(value: unknown, seen = new WeakSet<object>()): JsonCompatible | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: JsonCompatible[] = [];
    const length = arrayLengthFromDescriptors(descriptors);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor)) {
        output.push(null);
        continue;
      }
      output.push(sanitizeForJson(descriptor.value, seen) ?? null);
    }
    seen.delete(value);
    return output;
  }
  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      return null;
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const output: { [key: string]: JsonCompatible } = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor)) {
        continue;
      }
      const sanitized = sanitizeForJson(descriptor.value, seen);
      if (sanitized !== undefined) {
        output[key] = sanitized;
      }
    }
    seen.delete(value);
    return output;
  }
  return undefined;
}

function stableStringify(value: JsonCompatible): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(stableStringify(value[index] ?? null));
    }
    return `[${items.join(',')}]`;
  }
  const entries = Object.entries(value)
    .sort(([a], [b]) => compareCodePointKeys(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

export function hashAgentAttackPackManifest(manifest: unknown): string {
  const sanitized = sanitizeForJson(manifest) ?? null;
  return createHash('sha256').update(stableStringify(sanitized)).digest('hex');
}

export function lintAgentAttackPackManifest(manifest: unknown): AgentAttackPackLintResult {
  const errors: string[] = [];
  const seen = new WeakSet<object>();

  function visit(value: unknown, path: string, depth: number): void {
    if (depth > 24) {
      errors.push(`${path}: manifest nesting is too deep`);
      return;
    }
    if (typeof value === 'function') {
      errors.push(`${path}: executable function values are not allowed`);
      return;
    }
    if (typeof value === 'string') {
      for (const { label, pattern } of DANGEROUS_TEXT_PATTERNS) {
        if (pattern.test(value)) {
          errors.push(`${path}: contains dangerous text (${label})`);
        }
      }
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    if (seen.has(value)) {
      return;
    }

    if (!Array.isArray(value) && !isPlainObject(value)) {
      errors.push(`${path}: non-plain object values are not allowed in attack pack manifests`);
      return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors).sort(compareCodePointKeys);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i]!;
        if (key === 'length') {
          continue;
        }
        const descriptor = descriptors[key]!;
        const childPath = isArrayIndexKey(key) ? `${path}[${key}]` : `${path}.${key}`;
        if (DANGEROUS_FIELD_NAMES.has(normalizeFieldName(key))) {
          errors.push(`${childPath}: dangerous executable field name is not allowed`);
        }
        if (!('value' in descriptor)) {
          errors.push(`${childPath}: accessor properties are not allowed in attack pack manifests`);
          continue;
        }
        visit(descriptor.value, childPath, depth + 1);
      }
      seen.delete(value);
      return;
    }

    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      const childPath = path === '$' ? `$.${key}` : `${path}.${key}`;
      if (DANGEROUS_FIELD_NAMES.has(normalizeFieldName(key))) {
        errors.push(`${childPath}: dangerous executable field name is not allowed`);
      }
      if (!('value' in descriptor)) {
        errors.push(`${childPath}: accessor properties are not allowed in attack pack manifests`);
        continue;
      }
      visit(descriptor.value, childPath, depth + 1);
    }
    seen.delete(value);
  }

  visit(manifest, '$', 0);
  return { status: errors.length > 0 ? 'FAIL' : 'PASS', errors };
}

function buildStoredManifest(
  manifest: unknown,
  source: AgentAttackPackSource,
  lint: AgentAttackPackLintResult,
): Prisma.InputJsonObject {
  const sanitized = sanitizeForJson(manifest);
  const base: { [key: string]: JsonCompatible } = isRecord(sanitized)
    ? sanitized
    : { value: sanitized ?? null };
  return {
    ...base,
    source: {
      id: source.id,
      name: source.name,
      sourceUrl: source.sourceUrl,
      sourceRefs: source.sourceRefs,
    },
    lint: {
      status: lint.status,
      errors: lint.errors,
    },
  } as Prisma.InputJsonObject;
}

export async function syncAgentAttackPackSource(
  prisma: AgentAttackPackPrisma,
  sourceIdOrUrl: string,
  fetcher?: AgentAttackPackFetcher,
): Promise<AgentAttackPackSyncResult> {
  const source = resolveAgentAttackPackSource(sourceIdOrUrl);
  if (!fetcher) {
    throw new Error(
      'Agent attack pack sync requires an injected fetcher and does not perform direct network requests',
    );
  }

  const fetched = fetcher(source);
  const manifest = fetched instanceof Promise ? readAsyncFetchedManifest(await fetched) : fetched;
  const lint = lintAgentAttackPackManifest(manifest);
  const contentHash = hashAgentAttackPackManifest(manifest);
  const name = topLevelString(manifest, 'name') ?? source.name;
  const commitSha = topLevelString(manifest, 'commitSha');
  const license = topLevelString(manifest, 'license');
  const storedManifest = buildStoredManifest(manifest, source, lint);

  const existing = await prisma.agentAttackPack.findFirst({
    where: { sourceUrl: source.sourceUrl, contentHash },
  });

  const pack = existing
    ? await prisma.agentAttackPack.update({
        where: { id: existing.id },
        data: {
          name,
          commitSha,
          license,
          manifest: storedManifest,
          ...(lint.status === 'FAIL' ? { status: 'STAGED' } : {}),
        },
      })
    : await prisma.agentAttackPack.create({
        data: {
          name,
          sourceUrl: source.sourceUrl,
          commitSha,
          license,
          contentHash,
          status: 'STAGED',
          manifest: storedManifest,
        },
      });

  return { source, lint, pack };
}
