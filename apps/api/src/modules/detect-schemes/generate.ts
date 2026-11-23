import {
  TOOL_TASK_ENTRIES,
  type DetectCategory,
  type DetectJobItemKind,
  type ToolTaskEntryKey,
} from '@lse/shared';

// 方案清单生成规则（2.8.2，规则表 R1～R13 见计划）。纯函数：只对需求配置里的资产、只出需求配置里的类别；
// 同一资产同一入口只出一条；标题「<入口中文名> · <资产名>」。

export interface GenerateAsset {
  id: string;
  type: string;
  /** 显示名（终端、AI 模型关联了源对象时是主机名、评估对象名） */
  name: string;
  attrs: Record<string, unknown>;
  /** 关联的终端（已移除的终端按没关联算，由调用方传 null） */
  fleetEndpointId: string | null;
  modelTargetId: string | null;
}

export interface GenerateContext {
  /** 模型文件扫描的允许目录 */
  modelFileRoots: string[];
  /** 资产测绘已配的端口 */
  discoveryPorts: number[];
}

export interface GeneratedItem {
  assetId: string;
  category: DetectCategory;
  entryKey: ToolTaskEntryKey;
  mode: 'auto' | 'manual';
  jobKind: DetectJobItemKind | null;
  params: Record<string, unknown>;
  title: string;
}

/** 内容评估子任务的默认引擎（规则判定 + 敏感信息）。样本库要用户在清单维护里选。 */
export const SCHEME_EVAL_ENGINES = ['rule-judge', 'sensitive-info'] as const;

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** 去掉末尾斜杠（根目录「/」保留）。 */
function trimSlash(p: string): string {
  const t = p.replace(/\/+$/, '');
  return t || '/';
}

/**
 * 模型目录是否在允许目录内：字符串前缀比较，规范化末尾斜杠；含「..」段的一律不算（防止前缀相同但跳出目录）。
 */
export function isPathInRoots(path: string, roots: readonly string[]): boolean {
  if (!path.startsWith('/') || path.split('/').includes('..')) return false;
  const p = trimSlash(path);
  return roots.some((root) => {
    if (!root.startsWith('/')) return false;
    const r = trimSlash(root);
    return p === r || p.startsWith(r === '/' ? '/' : `${r}/`);
  });
}

function urlOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

type Rule = Omit<GeneratedItem, 'assetId' | 'category' | 'title'>;

const evalParams = (modelTargetId: string) => ({
  modelTargetId,
  questionSetIds: [],
  engines: [...SCHEME_EVAL_ENGINES],
  dimensions: [],
  concurrency: 4,
});

/** 单个资产按规则表出的清单项（未按类别过滤）。 */
function rulesFor(asset: GenerateAsset, ctx: GenerateContext): Rule[] {
  const out: Rule[] = [];
  const auto = (
    entryKey: ToolTaskEntryKey,
    jobKind: DetectJobItemKind,
    params: Record<string, unknown>,
  ) => out.push({ entryKey, mode: 'auto', jobKind, params });
  const manual = (entryKey: ToolTaskEntryKey, params: Record<string, unknown>) =>
    out.push({ entryKey, mode: 'manual', jobKind: null, params });
  const a = asset.attrs;
  const targetId = asset.modelTargetId ? { targetId: asset.modelTargetId } : {};

  switch (asset.type) {
    case 'model': {
      if (asset.modelTargetId) {
        auto('content-eval', 'eval_task', evalParams(asset.modelTargetId)); // R1
        manual('red-team', { modelTargetId: asset.modelTargetId }); // R2
      }
      const path = text(a.modelPath);
      if (path && isPathInRoots(path, ctx.modelFileRoots)) {
        auto('model-file-scan', 'model_file_scan', { source: 'directory', path, ...targetId }); // R3
      } else {
        manual('model-file-scan', { ...targetId }); // R4
      }
      manual('corpus-scan', {}); // R5
      break;
    }
    case 'platform': {
      if (asset.modelTargetId) auto('content-eval', 'eval_task', evalParams(asset.modelTargetId)); // R6
      const url = text(a.url);
      const origin = url ? urlOrigin(url) : null;
      if (url && origin) {
        auto('asset-discovery', 'asset_discovery', { targets: [origin], ports: [], confirm: true }); // R7
        manual('service-assurance', { url }); // R8
      }
      break;
    }
    case 'server':
    case 'endpoint': {
      const ip = text(a.ip);
      if (asset.fleetEndpointId) {
        auto('fleet-posture', 'fleet_posture', { endpointId: asset.fleetEndpointId }); // R9
      } else {
        manual('fleet-onboard', ip ? { host: ip } : {}); // R10
      }
      if (asset.type === 'server' && ip) {
        auto('asset-discovery', 'asset_discovery', {
          targets: [ip],
          ports: [...ctx.discoveryPorts],
          confirm: true,
        }); // R11
      }
      break;
    }
    case 'component': {
      const assetKey = text(a.assetKey);
      const endpointUrl = text(a.endpointUrl);
      manual('ai-component-scan', {
        ...(assetKey ? { assetKey } : {}),
        ...(endpointUrl ? { endpointUrl } : {}),
      }); // R12
      break;
    }
    case 'software':
      manual('service-assurance', {}); // R13：按 SBOM 方式核验
      break;
  }
  return out;
}

export function generateSchemeItems(
  requirement: { categories: readonly DetectCategory[]; assetIds: readonly string[] },
  assets: readonly GenerateAsset[],
  ctx: GenerateContext,
): GeneratedItem[] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const categories = new Set(requirement.categories);
  const seen = new Set<string>();
  const items: GeneratedItem[] = [];
  for (const assetId of new Set(requirement.assetIds)) {
    const asset = byId.get(assetId);
    if (!asset) continue;
    for (const rule of rulesFor(asset, ctx)) {
      const entry = TOOL_TASK_ENTRIES[rule.entryKey];
      if (!categories.has(entry.category)) continue;
      const key = `${asset.id}|${rule.entryKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        ...rule,
        assetId: asset.id,
        category: entry.category,
        title: `${entry.label} · ${asset.name}`,
      });
    }
  }
  return items;
}
