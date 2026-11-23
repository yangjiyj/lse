import { prisma } from '../../db.js';
import { badRequest, conflict } from '../../lib/errors.js';
import type { RuntimeSample } from '../../../../../packages/shared/src/runtime-eval.js';
import type { EndpointScenarioDefinition } from '../endpoint-evals/pack.js';

export type CatalogEntry = {
  id: string; suite: string; source: string; enabled: boolean; version: number; digest: string;
  content: RuntimeSample | EndpointScenarioDefinition;
};

export async function loadSampleCatalog(pins: Array<{ id: string; version: number }> = []): Promise<CatalogEntry[]> {
  const rows = await prisma.agentSample.findMany({ orderBy: { id: 'asc' },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
  // 只保留本租户可见样本的固定版本：别的租户的自定义样本编号在这里按不存在处理。
  const visibleIds = new Set(rows.map((row) => row.id));
  const visiblePins = pins.filter((pin) => visibleIds.has(pin.id));
  if (visiblePins.length !== pins.length) throw badRequest('所选样本版本不存在');
  const pinnedVersions = visiblePins.length ? await prisma.agentSampleVersion.findMany({ where: {
    OR: visiblePins.map((pin) => ({ sampleId: pin.id, version: pin.version })),
  } }) : [];
  if (pinnedVersions.length !== visiblePins.length) throw badRequest('所选样本版本不存在');
  return rows.map((row) => {
    const current = row.versions[0];
    if (!current || current.version !== row.currentVersion) throw conflict(`样本 ${row.id} 的当前版本不可用`);
    const pin = pins.find((item) => item.id === row.id);
    const chosen = pin ? pinnedVersions.find((item) => item.sampleId === row.id && item.version === pin.version)! : current;
    return { id: row.id, suite: row.suite, source: row.source, enabled: row.enabled,
      version: chosen.version, digest: chosen.digest,
      content: chosen.content as unknown as RuntimeSample | EndpointScenarioDefinition };
  });
}
