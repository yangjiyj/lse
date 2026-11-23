import { loadKitCatalog, type KitItem } from '../fleet-admin/kits.js';
import type { ToolVersionView } from './service.js';

// 内置「终端探针」：版本不入库，从 FLEET_KIT_DIR 的安装包清单实时读出来展示；
// 下载仍走 /api/fleet/kits/:filename（只有一键脚本支持的 Linux 包能直接下载，其余要先建接入码）。

const OS_ALIASES: Record<string, string> = { darwin: 'macos', mac: 'macos', osx: 'macos' };
const ARCH_ALIASES: Record<string, string> = { x86_64: 'amd64', x64: 'amd64', aarch64: 'arm64' };

export function kitVersionViews(items: readonly KitItem[]): ToolVersionView[] {
  return items.map((item) => ({
    id: `kit-${item.target}`,
    version: item.version,
    os: OS_ALIASES[item.os] ?? item.os,
    arch: ARCH_ALIASES[item.arch] ?? item.arch,
    filename: item.filename,
    size: item.bytes,
    sha256: item.sha256,
    releaseNotes: '',
    createdAt: null,
    createdBy: null,
    downloadUrl: item.oneclick ? `/api/fleet/kits/${encodeURIComponent(item.filename)}` : null,
  }));
}

/** 安装包清单读不到时返回空列表（清单问题在终端接入页提示，这里不报错）。 */
export async function builtinProbeVersions(): Promise<ToolVersionView[]> {
  const catalog = await loadKitCatalog();
  return kitVersionViews(catalog.items);
}
