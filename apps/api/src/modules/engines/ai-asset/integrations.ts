import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../db.js';
import { resolveServerTargetEgressContext } from '../../../lib/target-egress-policy.js';
import { withTenant } from '../../../lib/tenant-context.js';
import type { EngineInputFile } from './engine/index.js';
import type { RuleHit } from './engine/poisoning.js';

/**
 * 与 vulndb / mcp-fetch 两个独立模块（另一工作流交付）的对接点。
 * 模块未合入时以 feature 判断降级：依赖漏洞不报、MCP 在线拉取不可用，并在界面如实提示。
 * 使用运行时动态导入，避免模块缺失时编译失败。
 */
interface VulnMatch {
  ecosystem: 'pypi' | 'npm';
  packageName: string;
  version: string;
  versionKind: 'exact' | 'range';
  file: string;
  line: number;
  cves: string[];
  highestSeverity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  title: string;
  remediation: string;
  certainty: 'CONFIRMED' | 'POSSIBLE';
  advisories: Array<{ id: string; cve: string | null; severity: string; title: string }>;
  source: string;
}
interface VulnDbModule {
  matchDependencyVulns(files: Array<{ path: string; content: string }>): VulnMatch[];
}
interface McpToolSnapshot {
  endpoint: string;
  transport: string;
  serverInfo: unknown;
  tools: Array<{ name: string; description: string; inputSchema: unknown; baselineHash?: string }>;
  prompts: unknown[] | null;
  resources: unknown[] | null;
  warnings?: string[];
  [k: string]: unknown;
}
interface McpFetchModule {
  fetchMcpToolSnapshot(url: string, headers: Record<string, string>, opts?: Record<string, unknown>): Promise<McpToolSnapshot>;
}

async function tryImport<T>(spec: string): Promise<T | null> {
  try {
    return (await import(spec)) as T;
  } catch {
    return null;
  }
}

const VULNDB_SPEC = './vulndb/index.js';
const MCP_FETCH_SPEC = './mcp-fetch/index.js';
const vulndb = await tryImport<VulnDbModule>(new URL(VULNDB_SPEC, import.meta.url).href);
const mcpFetch = await tryImport<McpFetchModule>(new URL(MCP_FETCH_SPEC, import.meta.url).href);

export const VULNDB_AVAILABLE = typeof vulndb?.matchDependencyVulns === 'function';
export const MCP_FETCH_AVAILABLE = typeof mcpFetch?.fetchMcpToolSnapshot === 'function';

/** 与 mcp-fetch 的 toolBaselineHash 同口径：sha256(描述 + "\n" + 键按码位排序的 schema JSON，缺省为 {}) */
function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export function toolDescriptionHash(description: string, inputSchema: unknown): string {
  return createHash('sha256').update(`${description}\n${stableStringify(inputSchema ?? {})}`).digest('hex');
}

/** 把 MCP 拉取快照转成引擎可解析的 tools.json 虚拟文件 */
export function snapshotToFile(snapshot: McpToolSnapshot): EngineInputFile {
  const { tools, prompts, resources } = snapshot;
  return { path: 'mcp-endpoint/tools-list.json', content: JSON.stringify({ tools, prompts: prompts ?? [], resources: resources ?? [] }, null, 2) };
}

export async function fetchEndpointSnapshot(url: string, headers: Record<string, string>): Promise<{ snapshot: McpToolSnapshot; file: EngineInputFile }> {
  if (!mcpFetch) throw new Error('MCP 在线拉取模块尚未启用');
  const snapshot = await mcpFetch.fetchMcpToolSnapshot(url, headers, { egress: { context: resolveServerTargetEgressContext() } });
  return { snapshot, file: snapshotToFile(snapshot) };
}

/** 依赖漏洞 + 工具描述基线（rug pull / shadowing），并更新基线表。 */
type ToolDef = { name: string; description: string; inputSchema?: unknown; annotations?: Record<string, unknown>; path?: string; line?: number };
const jsonOrNull = (v: unknown) => (v === undefined ? null : (v as Prisma.InputJsonValue | null));
const sameJson = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);

export async function componentExtraHits(ctx: {
  assetKey: string;
  files: EngineInputFile[];
  tools: ToolDef[];
}): Promise<RuleHit[]> {
  const hits: RuleHit[] = [];
  if (vulndb) {
    for (const m of vulndb.matchDependencyVulns(ctx.files)) {
      const all = m.cves.length ? m.cves : m.advisories.map((a) => a.id);
      const ids = all.length > 10 ? `${all.slice(0, 10).join('、')} 等 ${all.length} 个` : all.join('、');
      const possible = m.certainty === 'POSSIBLE';
      hits.push({
        ruleId: 'dep.known_vulnerability',
        path: m.file,
        line: m.line || 1,
        // 每个（包名, 版本）独立成条：标题与指纹都带包名和版本，证据只列本包命中的漏洞
        groupKey: `${m.ecosystem}:${m.packageName.toLowerCase()}@${m.version}`,
        titleSuffix: `：${m.packageName} ${m.version}`,
        excerpt: `${m.packageName} ${m.version}${possible ? '（版本范围允许安装受影响版本）' : ''} 命中 ${ids}：${m.title}`.slice(0, 400),
        confidence: possible ? 0.55 : 0.9,
        severity: m.highestSeverity === 'UNKNOWN' ? undefined : possible && m.highestSeverity === 'CRITICAL' ? 'HIGH' : m.highestSeverity,
        meta: { vuln: { packageName: m.packageName, version: m.version, ecosystem: m.ecosystem, certainty: m.certainty, cves: m.cves, advisories: m.advisories.slice(0, 20), remediation: m.remediation, source: m.source } },
      });
    }
  }
  const tools = new Map(ctx.tools.filter((t) => t.name).map((t) => [t.name, t]));
  if (!tools.size) return hits;
  const names = [...tools.keys()];
  // 工具基线按租户隔离（唯一键含 tenantId，查询扩展在请求里自动加租户条件）：
  // 别人的基线既不会参与本租户的 rug pull 判定，也不会在告警里露出别人的资产名与工具描述。
  const [own, others] = await Promise.all([
    prisma.aiComponentToolBaseline.findMany({ where: { assetKey: ctx.assetKey, toolName: { in: names } } }),
    prisma.aiComponentToolBaseline.findMany({ where: { assetKey: { not: ctx.assetKey }, toolName: { in: names } }, take: 500 }),
  ]);
  const ownMap = new Map(own.map((b) => [b.toolName, b]));
  for (const [name, t] of tools) {
    const hash = toolDescriptionHash(t.description, t.inputSchema);
    const base = ownMap.get(name);
    if (base && base.descriptionHash !== hash) {
      // 逐字段记录基线值与当前值，供对比弹窗做字段级 diff；旧基线未记录 schema 时如实标注
      const recorded = base.inputSchema !== null;
      const changedFields = [
        base.description !== t.description ? 'description' : null,
        !recorded || !sameJson(base.inputSchema, t.inputSchema ?? {}) ? 'inputSchema' : null,
        !sameJson(base.annotations, t.annotations) ? 'annotations' : null,
      ].filter((x): x is string => !!x);
      hits.push({
        ruleId: 'mcp.rug_pull',
        path: t.path ?? 'tools',
        line: t.line ?? 1,
        toolName: name,
        excerpt: base.description === t.description ? `描述未变，参数定义或注解与基线不同：${t.description.slice(0, 200)}` : `基线描述：${base.description.slice(0, 160)} → 当前描述：${t.description.slice(0, 160)}`,
        meta: {
          changedFields,
          baseline: {
            firstScanId: base.firstScanId,
            previousHash: base.descriptionHash,
            currentHash: hash,
            previousDescription: base.description.slice(0, 4000),
            previousInputSchema: base.inputSchema ?? null,
            previousAnnotations: base.annotations ?? null,
            inputSchemaRecorded: recorded,
          },
          currentTool: { description: t.description.slice(0, 8000), inputSchema: t.inputSchema ?? null, annotations: t.annotations ?? null },
        },
      });
    }
    const shadow = others.find((o) => o.toolName === name && o.descriptionHash !== hash);
    if (shadow) {
      hits.push({ ruleId: 'mcp.tool_shadowing', path: t.path ?? 'tools', line: t.line ?? 1, toolName: name, excerpt: `与资产 ${shadow.assetKey.replace(/^[A-Z]+:/, '')} 的同名工具 ${name} 描述不同`, meta: { shadowOf: shadow.assetKey } });
    }
  }
  return hits;
}

/** 扫描落库后更新基线：首次出现写入；描述变化时保留首个基线不覆盖（持续报 rug pull 直到人工确认）。
 *  哈希未变而基线缺 schema/注解（旧数据）时回填，便于之后做字段级对比。 */
export async function updateToolBaselines(scanId: string, assetKey: string, tools: ToolDef[]): Promise<void> {
  // 按首次扫描记录的租户执行：基线表的唯一键是 (tenantId, assetKey, toolName)，
  // 不能再用 assetKey+toolName 做 upsert（那样会跨租户覆盖别人的基线）。
  const scan = await prisma.aiComponentScan.findUnique({ where: { id: scanId }, select: { tenantId: true } });
  await withTenant(scan?.tenantId, async () => {
    for (const t of tools) {
      if (!t.name) continue;
      const hash = toolDescriptionHash(t.description, t.inputSchema);
      const existing = await prisma.aiComponentToolBaseline.findFirst({
        where: { assetKey, toolName: t.name },
        select: { id: true, descriptionHash: true },
      });
      if (!existing) {
        await prisma.aiComponentToolBaseline.create({
          data: { assetKey, toolName: t.name, descriptionHash: hash, description: t.description.slice(0, 8000), inputSchema: jsonOrNull(t.inputSchema ?? {}) ?? Prisma.JsonNull, annotations: jsonOrNull(t.annotations) ?? Prisma.JsonNull, firstScanId: scanId, lastScanId: scanId },
        });
        continue;
      }
      const same = existing.descriptionHash === hash;
      await prisma.aiComponentToolBaseline.update({
        where: { id: existing.id },
        data: same ? { lastScanId: scanId, inputSchema: jsonOrNull(t.inputSchema ?? {}) ?? Prisma.JsonNull, annotations: jsonOrNull(t.annotations) ?? Prisma.JsonNull } : { lastScanId: scanId },
      });
    }
  });
}

/** 人工确认描述变更后重置基线 */
export async function acceptToolBaseline(assetKey: string, toolName: string, current: { description: string; inputSchema?: unknown; annotations?: unknown }, scanId: string): Promise<void> {
  const scan = await prisma.aiComponentScan.findUnique({ where: { id: scanId }, select: { tenantId: true } });
  const data = {
    descriptionHash: toolDescriptionHash(current.description, current.inputSchema),
    description: current.description.slice(0, 8000),
    inputSchema: jsonOrNull(current.inputSchema ?? {}) ?? Prisma.JsonNull,
    annotations: jsonOrNull(current.annotations) ?? Prisma.JsonNull,
    firstScanId: scanId,
    lastScanId: scanId,
  };
  await withTenant(scan?.tenantId, async () => {
    const existing = await prisma.aiComponentToolBaseline.findFirst({
      where: { assetKey, toolName },
      select: { id: true },
    });
    // 本租户还没有基线（例如首次扫描没记下来）时直接建一条，而不是按 ID 更新炸 500。
    if (!existing) {
      await prisma.aiComponentToolBaseline.create({ data: { assetKey, toolName, ...data } });
      return;
    }
    await prisma.aiComponentToolBaseline.update({ where: { id: existing.id }, data });
  });
}
