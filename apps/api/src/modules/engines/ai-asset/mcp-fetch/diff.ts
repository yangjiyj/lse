/**
 * 工具描述基线比对（纯函数）：新增/删除、描述变化（rug pull）、schema 变化、跨服务同名（shadowing）。
 *
 * BaselineEntry 对齐 AiComponentToolBaseline 表：descriptionHash 为
 * sha256(描述 + "\n" + 键排序 inputSchema JSON)（= McpToolEntry.baselineHash）。
 * 表里只存了 description 原文、没有单独的 schema 哈希，所以：
 *   - 描述原文不同 → descriptionChanged（rug pull，附文本差异摘要）
 *   - 描述原文相同但 descriptionHash 不同 → schemaChanged
 * 调用方可在 BaselineEntry.schemaSha256 里补充上次的 schema 哈希，此时两类变化可同时被识别。
 */
import { sha256Hex, textDiffSummary } from './hash.js';
import type { McpToolSnapshot } from './types.js';

export interface BaselineEntry {
  assetKey: string;
  toolName: string;
  descriptionHash: string;
  description: string;
  firstScanId: string;
  lastScanId: string;
  updatedAt?: Date | string;
  createdAt?: Date | string;
  /** 可选：上次快照的 schemaSha256（表中无此列，调用方有则传）。 */
  schemaSha256?: string;
}

export interface ToolDescriptionChange {
  toolName: string;
  prevHash: string;
  nextHash: string;
  prevDescriptionSha256: string;
  nextDescriptionSha256: string;
  diff: { removed: string; added: string; prefixLength: number };
  firstScanId: string;
}

export interface ToolSchemaChange {
  toolName: string;
  prevHash: string;
  nextHash: string;
  prevSchemaSha256: string | null;
  nextSchemaSha256: string;
}

export interface ToolShadowing {
  toolName: string;
  /** 与之同名的其他服务（assetKey 或服务名），已去重排序。 */
  servers: string[];
}

export interface ToolBaselineDiff {
  isFirstScan: boolean;
  added: string[];
  removed: string[];
  descriptionChanged: ToolDescriptionChange[];
  schemaChanged: ToolSchemaChange[];
  unchanged: string[];
  shadowing: ToolShadowing[];
}

export function diffToolBaseline(
  prev: BaselineEntry[],
  next: McpToolSnapshot,
  otherServersTools: { server: string; name: string }[] = [],
): ToolBaselineDiff {
  const prevByName = new Map(prev.map((entry) => [entry.toolName, entry]));
  const nextNames = new Set(next.tools.map((tool) => tool.name));
  const result: ToolBaselineDiff = {
    isFirstScan: prev.length === 0,
    added: [],
    removed: [],
    descriptionChanged: [],
    schemaChanged: [],
    unchanged: [],
    shadowing: [],
  };
  for (const tool of next.tools) {
    const base = prevByName.get(tool.name);
    if (!base) {
      result.added.push(tool.name);
      continue;
    }
    if (base.descriptionHash === tool.baselineHash) {
      result.unchanged.push(tool.name);
      continue;
    }
    const descriptionDiffers = base.description !== tool.description;
    if (descriptionDiffers) {
      result.descriptionChanged.push({
        toolName: tool.name,
        prevHash: base.descriptionHash,
        nextHash: tool.baselineHash,
        prevDescriptionSha256: sha256Hex(base.description),
        nextDescriptionSha256: tool.descriptionSha256,
        diff: textDiffSummary(base.description, tool.description),
        firstScanId: base.firstScanId,
      });
    }
    const schemaKnownChanged = base.schemaSha256 !== undefined && base.schemaSha256 !== tool.schemaSha256;
    if (!descriptionDiffers || schemaKnownChanged) {
      result.schemaChanged.push({
        toolName: tool.name,
        prevHash: base.descriptionHash,
        nextHash: tool.baselineHash,
        prevSchemaSha256: base.schemaSha256 ?? null,
        nextSchemaSha256: tool.schemaSha256,
      });
    }
  }
  for (const entry of prev) if (!nextNames.has(entry.toolName)) result.removed.push(entry.toolName);

  const others = new Map<string, Set<string>>();
  for (const item of otherServersTools) {
    if (!nextNames.has(item.name)) continue;
    const set = others.get(item.name) ?? new Set<string>();
    set.add(item.server);
    others.set(item.name, set);
  }
  for (const [toolName, servers] of others) result.shadowing.push({ toolName, servers: [...servers].sort() });

  result.added.sort();
  result.removed.sort();
  result.unchanged.sort();
  result.shadowing.sort((a, b) => a.toolName.localeCompare(b.toolName));
  return result;
}
