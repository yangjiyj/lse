// 工具中心（2.3.x）的共用口径：系统、架构、下载类型、手册格式、内置工具编码。后端校验和前端展示共用。

/** 内置「终端探针」的编码：版本不入库，从 FLEET_KIT_DIR 的安装包清单实时读出。 */
export const BUILTIN_PROBE_TOOL_CODE = 'endpoint-probe';

/** 工具编码：小写字母、数字、连字符，首尾不能是连字符，最长 64 位。 */
export const TOOL_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const TOOL_OS_VALUES = ['linux', 'windows', 'macos', 'any'] as const;
export type ToolOs = (typeof TOOL_OS_VALUES)[number];
export const TOOL_OS_LABELS: Record<ToolOs, string> = {
  linux: 'Linux',
  windows: 'Windows',
  macos: 'macOS',
  any: '不限系统',
};

export const TOOL_ARCH_VALUES = ['amd64', 'arm64', 'any'] as const;
export type ToolArch = (typeof TOOL_ARCH_VALUES)[number];
export const TOOL_ARCH_LABELS: Record<ToolArch, string> = {
  amd64: 'x86-64',
  arm64: 'ARM64',
  any: '不限架构',
};

export const TOOL_DOWNLOAD_KINDS = ['package', 'manual'] as const;
export type ToolDownloadKind = (typeof TOOL_DOWNLOAD_KINDS)[number];

/** 操作手册允许的格式（扩展名 → 下载时的 Content-Type）。 */
export const TOOL_MANUAL_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
} as const;
export type ToolManualExt = keyof typeof TOOL_MANUAL_TYPES;
export const TOOL_MANUAL_EXTS = Object.keys(TOOL_MANUAL_TYPES) as ToolManualExt[];

/** 操作手册单个文件上限：100 MiB。 */
export const TOOL_MANUAL_MAX_BYTES = 100 * 1024 * 1024;

/** 手册文件名的扩展名（小写，不含点）；不在白名单里返回 null。 */
export function toolManualExt(filename: string): ToolManualExt | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  const ext = m?.[1]?.toLowerCase();
  return ext && ext in TOOL_MANUAL_TYPES ? (ext as ToolManualExt) : null;
}
