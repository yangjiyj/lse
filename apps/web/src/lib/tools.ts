import type { DetectCategory, ToolTaskEntry } from '@lse/shared';
import {
  downloadRaw,
  request,
  startBrowserDownload,
  uploadRaw,
  type UploadRawOptions,
} from '@/lib/api';

// 工具中心，与 apps/api/src/modules/tools 对应。

export interface ToolUserRef {
  id: string;
  username: string;
}

export interface ToolPlatform {
  os: string;
  arch: string;
}

export interface ToolListItem {
  id: string;
  code: string;
  name: string;
  category: DetectCategory;
  description: string;
  taskEntry: string | null;
  task: ToolTaskEntry | null;
  enabled: boolean;
  hidden: boolean;
  builtin: boolean;
  latestVersion: { version: string; createdAt: string | null } | null;
  platforms: ToolPlatform[];
  versionCount: number;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ToolConfigParam {
  name: string;
  label: string;
  description: string;
  defaultValue: string;
  required: boolean;
}

export interface ToolVersion {
  id: string;
  version: string;
  os: string;
  arch: string;
  filename: string;
  size: number | null;
  sha256: string;
  releaseNotes: string;
  createdAt: string | null;
  createdBy: ToolUserRef | null;
  /** 站内下载地址；内置探针的非一键包要先建接入码，为 null。 */
  downloadUrl: string | null;
}

export interface ToolManual {
  id: string;
  title: string;
  filename: string;
  size: number;
  sha256: string;
  mime: string;
  createdAt: string;
  updatedAt: string;
  createdBy: ToolUserRef | null;
  downloadUrl: string;
}

export interface ToolDetail extends ToolListItem {
  /** 版本文件的上传上限（字节），上传前先比对。 */
  maxUploadBytes?: number;
  instructions: string;
  configParams: ToolConfigParam[];
  createdBy: ToolUserRef | null;
  versions: ToolVersion[];
  manuals: ToolManual[];
}

export interface ToolDownloadUserRow {
  userId: string | null;
  username: string | null;
  tenantName: string | null;
  packages: number;
  manuals: number;
  total: number;
  lastDownloadedAt: string | null;
}

export interface ToolDownloadRecent {
  createdAt: string;
  username: string | null;
  tenantName: string | null;
  kind: 'package' | 'manual';
  filename: string | null;
  ip: string;
}

export interface ToolDownloadSummary {
  /** 安装包下载总次数（手册不算）。 */
  total: number;
  byUser: ToolDownloadUserRow[];
  /** 近 30 天每天的安装包下载次数。 */
  trend: Array<{ date: string; count: number }>;
  /** 最近 50 条下载明细（含手册）。 */
  recent: ToolDownloadRecent[];
}

export interface ToolListQuery {
  category?: string;
  os?: string;
  arch?: string;
  keyword?: string;
}

export interface ToolInput {
  name: string;
  category: DetectCategory;
  description: string;
  instructions: string;
  configParams: ToolConfigParam[];
  taskEntry: string | null;
}

export interface ToolVersionMeta {
  version: string;
  os: string;
  arch: string;
  releaseNotes?: string;
}

/** 上传进度回调和取消信号。 */
export type UploadOptions = Pick<UploadRawOptions, 'onProgress' | 'signal'>;

/** 接口给的下载地址是带 /api 前缀的站内路径。 */
function apiPath(url: string): string {
  return url.startsWith('/api/') ? url.slice(4) : url;
}

export const toolsApi = {
  list(query: ToolListQuery = {}) {
    return request<{ items: ToolListItem[] }>('GET', '/tools', { query: { ...query } });
  },
  get(id: string) {
    return request<ToolDetail>('GET', `/tools/${encodeURIComponent(id)}`);
  },
  create(body: ToolInput & { code: string }) {
    return request<ToolDetail>('POST', '/tools', { body });
  },
  update(id: string, body: Partial<ToolInput> & { enabled?: boolean; hidden?: boolean }) {
    return request<ToolDetail>('PATCH', `/tools/${encodeURIComponent(id)}`, { body });
  },
  remove(id: string) {
    return request<void>('DELETE', `/tools/${encodeURIComponent(id)}`);
  },
  uploadVersion(id: string, file: File, meta: ToolVersionMeta, opts: UploadOptions = {}) {
    return uploadRaw<ToolVersion>('POST', `/tools/${encodeURIComponent(id)}/versions`, file, {
      ...opts,
      query: { ...meta, releaseNotes: meta.releaseNotes ?? '', filename: file.name },
    });
  },
  deleteVersion(id: string, versionId: string) {
    return request<void>(
      'DELETE',
      `/tools/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
    );
  },
  uploadManual(id: string, file: File, title?: string, opts: UploadOptions = {}) {
    return uploadRaw<ToolManual>('POST', `/tools/${encodeURIComponent(id)}/manuals`, file, {
      ...opts,
      query: { filename: file.name, ...(title ? { title } : {}) },
    });
  },
  replaceManual(
    id: string,
    manualId: string,
    file: File,
    title?: string,
    opts: UploadOptions = {},
  ) {
    return uploadRaw<ToolManual>(
      'PUT',
      `/tools/${encodeURIComponent(id)}/manuals/${encodeURIComponent(manualId)}`,
      file,
      { ...opts, query: { filename: file.name, ...(title ? { title } : {}) } },
    );
  },
  deleteManual(id: string, manualId: string) {
    return request<void>(
      'DELETE',
      `/tools/${encodeURIComponent(id)}/manuals/${encodeURIComponent(manualId)}`,
    );
  },
  /** 手册、内置探针一键包按接口给的地址带鉴权下载（文件小，拉成 blob 保存）。 */
  download(url: string, filename: string) {
    return downloadRaw(apiPath(url), filename);
  },
  /** 工具版本（可能很大）：先换一次性下载链接，再让浏览器原生下载，不经 blob。 */
  async downloadVersion(id: string, versionId: string) {
    const link = await request<{ url: string; expiresAt: string }>(
      'POST',
      `/tools/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/download-link`,
    );
    startBrowserDownload(link.url);
  },
  downloads(id: string) {
    return request<ToolDownloadSummary>('GET', `/tools/${encodeURIComponent(id)}/downloads`);
  },
};
