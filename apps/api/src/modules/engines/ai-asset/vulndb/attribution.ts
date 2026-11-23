/** 把单条 AIG 漏洞归属到具体包（导入期调用；纯函数，便于测试）。 */
import {
  COMPONENT_MAPPINGS,
  FILE_OVERRIDES,
  type ComponentMapping,
  type PackageRef,
} from './packages.js';

const BY_DIR = new Map<string, ComponentMapping>();
for (const mapping of COMPONENT_MAPPINGS) {
  for (const dir of mapping.dirs) BY_DIR.set(dir, mapping);
}

export function mappingForDir(dir: string): ComponentMapping | undefined {
  return BY_DIR.get(dir);
}

export interface AttributionInput {
  sourcePath: string;
  component: string;
  summary: string;
  details: string;
  remediation: string;
}

function firstIndex(pattern: RegExp, text: string): number {
  const flags = pattern.flags.replace('g', '');
  const m = new RegExp(pattern.source, flags).exec(text);
  return m ? m.index : -1;
}

/**
 * 依次在修复建议、标题、详情里找最早出现的包名线索；同一位置子包线索优先。
 * 都找不到时归属目录主包（目录即组件，默认条目属于它）。
 */
export function attributePackage(input: AttributionInput): PackageRef | null {
  if (Object.prototype.hasOwnProperty.call(FILE_OVERRIDES, input.sourcePath)) {
    return FILE_OVERRIDES[input.sourcePath] ?? null;
  }
  const mapping = mappingForDir(input.component);
  if (!mapping) return null;
  for (const text of [input.remediation, input.summary, input.details]) {
    if (!text) continue;
    let best: { index: number; target: PackageRef | null } | null = null;
    for (const hint of mapping.hints ?? []) {
      const index = firstIndex(hint.pattern, text);
      if (index >= 0 && (best === null || index < best.index)) best = { index, target: hint.target };
    }
    const selfIndex = firstIndex(mapping.self, text);
    if (selfIndex >= 0 && (best === null || selfIndex < best.index)) {
      best = { index: selfIndex, target: mapping.primary };
    }
    if (best) return best.target;
  }
  return mapping.primary;
}
