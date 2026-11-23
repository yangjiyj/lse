import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { displayFilename, removeStored, storeUpload, toolUploadMaxBytes } from './storage.js';

// 预置工具：部署时由运维登记一个随版本发布的工具文件（目前是语料扫描命令行版）。
// 和内置工具不同，预置工具是普通工具：管理员之后可以上传新版本、改说明、禁用或删除。
// 登记可以重复执行：工具已存在时不改它的名称、说明和状态；同一版本、系统、架构内容相同就跳过。

const CORPUS_CLI_INSTRUCTIONS = [
  '1. 需要 Node.js 22.6 或更高版本，不用安装其他依赖。',
  '2. 解压：tar -xzf corpus-scan-cli-<版本>.tar.gz',
  '3. 扫描：node --experimental-strip-types corpus-scan-cli-<版本>/cli.ts 语料文件 --out report.json',
  '4. 自定义规则：加 --rules 规则.csv，格式与平台「语料规则」的导入相同。',
  '5. 报告里的统计口径与平台的语料扫描一致，命中原文不打码，请按敏感数据保管。',
].join('\n');

export const PRESET_TOOLS = {
  'corpus-scan-cli': {
    code: 'corpus-scan-cli',
    name: '语料扫描（命令行版）',
    category: 'data',
    description: '离线扫描训练、微调语料里的违规内容和敏感信息，适合不能把语料上传到平台的场景。',
    instructions: CORPUS_CLI_INSTRUCTIONS,
    configParams: [
      {
        name: 'format',
        label: '语料格式',
        description:
          'auto、alpaca、sharegpt、messages、prompt_completion、chosen_rejected、csv、txt',
        defaultValue: 'auto',
        required: false,
      },
      {
        name: 'rules',
        label: '自定义规则文件',
        description: 'CSV 或 TXT，格式与平台「语料规则」的导入相同',
        defaultValue: '',
        required: false,
      },
      {
        name: 'csv-columns',
        label: 'CSV 检测列',
        description: '逗号分隔；不填检测全部列',
        defaultValue: '',
        required: false,
      },
      {
        name: 'out',
        label: '报告文件',
        description: '报告 JSON 的输出路径；不填输出到屏幕',
        defaultValue: '',
        required: false,
      },
    ],
    taskEntry: 'corpus-scan',
  },
} as const;

export type PresetToolCode = keyof typeof PRESET_TOOLS;

export function isPresetToolCode(value: string): value is PresetToolCode {
  return Object.prototype.hasOwnProperty.call(PRESET_TOOLS, value);
}

export interface RegisterPresetInput {
  code: PresetToolCode;
  file: string;
  version: string;
  os?: 'linux' | 'windows' | 'macos' | 'any';
  arch?: 'amd64' | 'arm64' | 'any';
  filename?: string;
  releaseNotes?: string;
}

export interface RegisterPresetResult {
  toolId: string;
  versionId: string;
  toolCreated: boolean;
  versionCreated: boolean;
  sha256: string;
}

type Db = Pick<PrismaClient, 'tool' | 'toolVersion'>;

export async function registerPresetToolVersion(
  db: Db,
  input: RegisterPresetInput,
): Promise<RegisterPresetResult> {
  const preset = PRESET_TOOLS[input.code];
  const version = input.version.trim();
  if (!version) throw new Error('版本号不能为空');
  const os = input.os ?? 'any';
  const arch = input.arch ?? 'any';
  const filename = displayFilename(input.filename ?? input.file.split('/').pop() ?? '');
  if (!filename) throw new Error('文件名不能为空');
  const info = await stat(input.file);
  if (!info.isFile() || info.size === 0) throw new Error(`不是非空文件：${input.file}`);

  let tool = await db.tool.findUnique({ where: { code: preset.code } });
  const toolCreated = !tool;
  if (!tool) {
    tool = await db.tool.create({
      data: {
        ...preset,
        configParams: preset.configParams.map((p) => ({ ...p })),
        builtin: false,
        enabled: true,
      },
    });
  }

  const stored = await storeUpload(
    createReadStream(input.file),
    info.size,
    toolUploadMaxBytes(),
    '工具文件',
  );
  const key = { toolId: tool.id, version, os, arch };
  const existing = await db.toolVersion.findUnique({ where: { toolId_version_os_arch: key } });
  if (existing) {
    await removeStored(stored.storageKey);
    if (existing.sha256 !== stored.sha256)
      throw new Error(
        `${preset.code} ${version}（${os}/${arch}）已登记过内容不同的文件，请换版本号或先在工具中心删除旧版本`,
      );
    return {
      toolId: tool.id,
      versionId: existing.id,
      toolCreated,
      versionCreated: false,
      sha256: existing.sha256,
    };
  }
  try {
    const created = await db.toolVersion.create({
      data: {
        ...key,
        filename,
        size: BigInt(stored.size),
        sha256: stored.sha256,
        storageKey: stored.storageKey,
        releaseNotes: (input.releaseNotes ?? '').slice(0, 500),
      },
    });
    return {
      toolId: tool.id,
      versionId: created.id,
      toolCreated,
      versionCreated: true,
      sha256: stored.sha256,
    };
  } catch (e) {
    await removeStored(stored.storageKey);
    throw e;
  }
}
