import {
  DETECT_CATEGORY_LABELS,
  TOOL_ARCH_LABELS,
  TOOL_OS_LABELS,
  type DetectCategory,
  type ToolArch,
  type ToolOs,
} from '@lse/shared';

export const TOOLS_QUERY_KEY = 'tools';

export function categoryLabel(category: string): string {
  return DETECT_CATEGORY_LABELS[category as DetectCategory] ?? category;
}

export function osLabel(os: string): string {
  return TOOL_OS_LABELS[os as ToolOs] ?? os;
}

export function archLabel(arch: string): string {
  return TOOL_ARCH_LABELS[arch as ToolArch] ?? arch;
}

/** 系统 · 架构；两者都不限时写「通用」。 */
export function platformLabel(p: { os: string; arch: string }): string {
  if (p.os === 'any' && p.arch === 'any') return '通用';
  return `${osLabel(p.os)} · ${archLabel(p.arch)}`;
}
