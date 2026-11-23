import type { Tool, ToolManual, ToolVersion } from '@prisma/client';
import { toolTaskEntry } from '@lse/shared';

// 工具中心的返回结构：列表项、详情、版本、手册。存储键（磁盘文件名）不出接口。

type UserRef = { id: string; username: string } | null;

export interface ToolVersionView {
  id: string;
  version: string;
  os: string;
  arch: string;
  filename: string;
  size: number | null;
  sha256: string;
  releaseNotes: string;
  createdAt: string | null;
  createdBy: UserRef;
  /** 下载地址（站内路径）；内置探针的非一键包需要先建接入码，为 null。 */
  downloadUrl: string | null;
}

export interface ToolManualView {
  id: string;
  title: string;
  filename: string;
  size: number;
  sha256: string;
  mime: string;
  createdAt: string;
  updatedAt: string;
  createdBy: UserRef;
  downloadUrl: string;
}

export interface ToolConfigParam {
  name: string;
  label: string;
  description: string;
  defaultValue: string;
  required: boolean;
}

type WithCreator<T> = T & { createdBy?: UserRef };

export function versionView(toolId: string, v: WithCreator<ToolVersion>): ToolVersionView {
  return {
    id: v.id,
    version: v.version,
    os: v.os,
    arch: v.arch,
    filename: v.filename,
    size: Number(v.size),
    sha256: v.sha256,
    releaseNotes: v.releaseNotes,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy ?? null,
    downloadUrl: `/api/tools/${toolId}/versions/${v.id}/download`,
  };
}

export function manualView(toolId: string, m: WithCreator<ToolManual>): ToolManualView {
  return {
    id: m.id,
    title: m.title,
    filename: m.filename,
    size: Number(m.size),
    sha256: m.sha256,
    mime: m.mime,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    createdBy: m.createdBy ?? null,
    downloadUrl: `/api/tools/${toolId}/manuals/${m.id}/download`,
  };
}

/** 新到旧；同一时刻上传的按版本号自然序倒排。 */
export function sortVersions(list: ToolVersionView[]): ToolVersionView[] {
  return [...list].sort(
    (a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? '') ||
      b.version.localeCompare(a.version, undefined, { numeric: true }),
  );
}

/** 各版本覆盖的系统和架构（去重，按系统、架构排序）。 */
export function platformsOf(list: ToolVersionView[]): Array<{ os: string; arch: string }> {
  const seen = new Map<string, { os: string; arch: string }>();
  for (const v of list) seen.set(`${v.os}/${v.arch}`, { os: v.os, arch: v.arch });
  return [...seen.values()].sort(
    (a, b) => a.os.localeCompare(b.os) || a.arch.localeCompare(b.arch),
  );
}

/** 系统、架构筛选：同一个版本要同时满足；「不限系统 / 不限架构」的版本匹配任何取值。 */
export function matchesPlatform(list: ToolVersionView[], os?: string, arch?: string): boolean {
  if (!os && !arch) return true;
  return list.some(
    (v) => (!os || v.os === os || v.os === 'any') && (!arch || v.arch === arch || v.arch === 'any'),
  );
}

export function configParamsOf(value: unknown): ToolConfigParam[] {
  return Array.isArray(value) ? (value as ToolConfigParam[]) : [];
}

export function listItemView(tool: Tool, versions: ToolVersionView[], downloadCount: number) {
  const sorted = sortVersions(versions);
  const latest = sorted[0];
  return {
    id: tool.id,
    code: tool.code,
    name: tool.name,
    category: tool.category,
    description: tool.description,
    taskEntry: tool.taskEntry,
    /** 「新建任务」「任务列表」的跳转路径，只按白名单给出。 */
    task: toolTaskEntry(tool.taskEntry),
    enabled: tool.enabled,
    hidden: tool.hidden,
    builtin: tool.builtin,
    latestVersion: latest ? { version: latest.version, createdAt: latest.createdAt } : null,
    platforms: platformsOf(sorted),
    versionCount: sorted.length,
    downloadCount,
    createdAt: tool.createdAt.toISOString(),
    updatedAt: tool.updatedAt.toISOString(),
  };
}

export function detailView(
  tool: WithCreator<Tool> & { manuals: Array<WithCreator<ToolManual>> },
  versions: ToolVersionView[],
  downloadCount: number,
) {
  return {
    ...listItemView(tool, versions, downloadCount),
    instructions: tool.instructions,
    configParams: configParamsOf(tool.configParams),
    createdBy: tool.createdBy ?? null,
    versions: sortVersions(versions),
    manuals: tool.manuals.map((m) => manualView(tool.id, m)),
  };
}
