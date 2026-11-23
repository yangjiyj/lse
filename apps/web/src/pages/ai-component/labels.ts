import type {
  AiComponentAssetType,
  AiComponentReviewStatus,
  AiComponentScanSummary,
} from '@/lib/api';

export const ASSET_TYPE_LABEL: Record<AiComponentAssetType, string> = {
  SKILL: 'Skill',
  MCP: 'MCP Server',
  PLUGIN: '插件',
};

export const SOURCE_TYPE_LABEL: Record<AiComponentScanSummary['sourceType'], string> = {
  UPLOAD: '上传文件',
  ARCHIVE: '上传压缩包/目录',
  MCP_ENDPOINT: 'MCP 服务地址',
};

export const REVIEW_LABEL: Record<AiComponentReviewStatus, string> = {
  PENDING: '待复核',
  CONFIRMED: '确认风险',
  FALSE_POSITIVE: '误报',
};

export const JUDGE_STATUS_LABEL: Record<string, string> = {
  NOT_NEEDED: '无需模型复核',
  NOT_CONFIGURED: '未经模型复核（未配置判定模型，可到 平台设置 配置）',
  REVIEWED: '已经判定模型复核',
  FAILED: '模型复核失败',
  PENDING: '待模型复核',
  SKIPPED: '超出单次复核上限，未经模型复核',
};

/** 风险色：高 #B42318、中 #B04A05、低 #5B6778（严重按高处理） */
export const SEVERITY_TEXT: Record<string, string> = {
  CRITICAL: 'text-[#B42318]',
  HIGH: 'text-[#B42318]',
  MEDIUM: 'text-[#B04A05]',
  LOW: 'text-[#5B6778]',
  INFO: 'text-[#5B6778]',
};

export const SEVERITY_BORDER: Record<string, string> = {
  CRITICAL: 'border-[#B42318] text-[#B42318]',
  HIGH: 'border-[#B42318] text-[#B42318]',
  MEDIUM: 'border-[#B04A05] text-[#B04A05]',
  LOW: 'border-[#5B6778] text-[#5B6778]',
  INFO: 'border-[#5B6778] text-[#5B6778]',
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function findingTotal(
  s: Pick<AiComponentScanSummary, 'criticalCount' | 'highCount' | 'mediumCount' | 'lowCount'>,
): number {
  return s.criticalCount + s.highCount + s.mediumCount + s.lowCount;
}
