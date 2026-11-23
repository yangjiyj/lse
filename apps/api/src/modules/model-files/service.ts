import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, type Severity } from '@prisma/client';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { buildCycloneDxMlBom, type AibomOptions } from './aibom.js';
import type { ScannedFile } from './filesystem.js';
import { AUX_FORMATS, DEFAULT_LIMITS } from './types.js';
import { normalizeHostDir, usableAdminRoots } from './roots.js';
import { GiB, TiB } from './units.js';

export { GiB, TiB };

export const SETTING_KEY = 'model_file_scan.config';
/**
 * 配置存储格式版本。缺失表示由旧版界面保存（那时界面把出厂默认值一并写进了库），
 * 用它区分“从未改过的旧默认值”和“管理员刻意设成的值”。
 */
export const CONFIG_SCHEMA_VERSION = 2;
/** 原始字节上传上限（MODEL_SCAN_UPLOAD_MAX_BYTES，默认 0 表示不限制）；上传为 octet-stream 流式落盘，不经 JSON/Base64。 */
export const UPLOAD_MAX_BYTES = config.MODEL_SCAN_UPLOAD_MAX_BYTES;
/** 上传文件目录（含持久文件库）：api 写入、worker 读取，容器部署时两者需挂同一卷。 */
export const UPLOAD_DIR = config.MODEL_SCAN_UPLOAD_DIR || join(tmpdir(), 'lse-model-scan-uploads');
/** 部署级白名单根（MODEL_SCAN_ROOTS，逗号分隔），与管理员页面配置取并集。 */
export const ENV_ROOTS = config.MODEL_SCAN_ROOTS.split(',')
  .map((s) => s.trim())
  .filter((s) => s.startsWith('/'));
/** 服务器上对应容器内 /models 的目录（MODEL_SCAN_HOST_DIR）；部署时未提供则为 null。 */
export const HOST_DIR = normalizeHostDir(config.MODEL_SCAN_HOST_DIR);

export interface ModelFileConfig {
  roots: string[];
  pickleMaxBytes: number;
  totalMaxBytes: number;
  maxFiles: number;
}
/**
 * 默认上限。总量按文件大小累加：每个文件都会被完整读取一遍以计算 SHA-256（见 filesystem.ts），
 * 实际读取量与文件大小一致，所以默认 1 TiB 即可一次扫完几百 GB 的大模型目录。
 */
export const DEFAULT_CONFIG: ModelFileConfig = {
  roots: [],
  pickleMaxBytes: DEFAULT_LIMITS.pickleMaxBytes,
  totalMaxBytes: 1 * TiB,
  maxFiles: 10_000,
};

/** 三项上限的合法取值范围（保存校验与读取收敛共用）。 */
export const LIMIT_BOUNDS = {
  pickleMaxBytes: { min: 1024, max: 8 * GiB },
  totalMaxBytes: { min: 1024, max: 16 * TiB },
  maxFiles: { min: 1, max: 100_000 },
} as const;

/** 旧版界面出厂值；schemaVersion 缺失且恰为这两个值时，视为从未改过，按新默认值处理。 */
const LEGACY_DEFAULT_TOTAL_MAX_BYTES = 20 * GiB;
const LEGACY_DEFAULT_MAX_FILES = 2000;

const num = (v: unknown, def: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), min), max) : def;

export async function loadConfig(): Promise<ModelFileConfig> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const legacy = typeof v.schemaVersion !== 'number';
  // 兼容旧配置字段 maxBytes（原为单次扫描总量）
  const rawTotal = v.totalMaxBytes ?? v.maxBytes;
  const b = LIMIT_BOUNDS;
  return {
    roots: Array.isArray(v.roots) ? v.roots.filter((x): x is string => typeof x === 'string') : [],
    pickleMaxBytes: num(
      v.pickleMaxBytes,
      DEFAULT_CONFIG.pickleMaxBytes,
      b.pickleMaxBytes.min,
      b.pickleMaxBytes.max,
    ),
    totalMaxBytes:
      legacy && rawTotal === LEGACY_DEFAULT_TOTAL_MAX_BYTES
        ? DEFAULT_CONFIG.totalMaxBytes
        : num(rawTotal, DEFAULT_CONFIG.totalMaxBytes, b.totalMaxBytes.min, b.totalMaxBytes.max),
    maxFiles:
      legacy && v.maxFiles === LEGACY_DEFAULT_MAX_FILES
        ? DEFAULT_CONFIG.maxFiles
        : num(v.maxFiles, DEFAULT_CONFIG.maxFiles, b.maxFiles.min, b.maxFiles.max),
  };
}

/** 生效白名单 = 部署级 MODEL_SCAN_ROOTS ∪ 管理员配置（历史遗留的系统目录、写法不对的条目不再生效）。 */
export function effectiveRoots(cfg: ModelFileConfig): string[] {
  return [...new Set([...ENV_ROOTS, ...usableAdminRoots(cfg.roots)])];
}

const SEVERITIES = new Set<Severity>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);

export interface CompleteInput {
  files: ScannedFile[];
  skipped: number;
  totalBytes: number;
  truncatedFiles: number;
  truncatedReason: string | null;
  aibom: AibomOptions;
}

/** 把扫描结果写入执行中的扫描记录（RUNNING → COMPLETED）；期间被取消则不覆盖，返回 false。 */
export async function completeScan(scanId: string, input: CompleteInput): Promise<boolean> {
  const findings = input.files.flatMap((f) =>
    f.findings.map((x) => ({
      scanId,
      filePath: f.path,
      format: x.format ?? f.format,
      severity: (SEVERITIES.has(x.severity as Severity) ? x.severity : 'MEDIUM') as Severity,
      ruleId: x.ruleId,
      title: x.title,
      evidence: x.detail.slice(0, 4000),
    })),
  );
  const count = (s: Severity[]) => findings.filter((f) => s.includes(f.severity)).length;
  const aibom = buildCycloneDxMlBom(
    input.files
      .filter((f) => !AUX_FORMATS.has(f.format))
      .map((f) => ({
        name: f.path.split(/[\\/]/).pop() || f.path,
        path: f.path,
        format: f.format,
        bytes: f.bytes,
        sha256: f.sha256,
        meta: f.meta,
      })),
    input.aibom,
  );
  return prisma.$transaction(async (tx) => {
    const done = await tx.modelFileScan.updateMany({
      where: { id: scanId, status: 'RUNNING' },
      data: {
        status: 'COMPLETED',
        fileCount: input.files.length,
        totalBytes: BigInt(input.totalBytes),
        skippedCount: input.skipped,
        truncatedCount: input.truncatedFiles,
        truncatedReason: input.truncatedReason,
        highCount: count(['CRITICAL', 'HIGH']),
        mediumCount: count(['MEDIUM']),
        lowCount: count(['LOW']),
        files: input.files.map((f) => ({
          path: f.path,
          format: f.format,
          bytes: f.bytes,
          sha256: f.sha256,
          meta: f.meta,
        })) as unknown as Prisma.InputJsonValue,
        aibom: aibom as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
    if (done.count === 0) return false;
    if (findings.length) await tx.modelFileFinding.createMany({ data: findings });
    return true;
  });
}

export type ScanRow = Prisma.ModelFileScanGetPayload<{
  include: {
    target: { select: { id: true; name: true } };
    createdBy: { select: { id: true; displayName: true } };
  };
}>;

export function serializeScan(row: ScanRow) {
  const { aibom, totalBytes, progressBytes, plannedBytes, request: _r, ...rest } = row;
  return {
    ...rest,
    totalBytes: Number(totalBytes),
    progressBytes: Number(progressBytes),
    plannedBytes: Number(plannedBytes),
    hasAibom: aibom !== null,
  };
}
