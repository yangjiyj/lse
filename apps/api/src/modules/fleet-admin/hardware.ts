import type {
  EndpointAccelerator,
  EndpointAIComponent,
  EndpointDisk,
  EndpointHardware,
} from '../../../../../packages/shared/src/endpoint-hardware.js';
import { rec, safeText } from './inventory.js';

const MAX_ACCELERATORS = 64;
const MAX_AI_COMPONENTS = 256;
const MAX_DISKS = 64;
const MAX_ERROR_CODES = 8;
const ERROR_CODE = /^[a-z_]{1,64}$/;

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const whole = (value: unknown): number | undefined => {
  const n = count(value);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
};
/** 只放有值的键：旧探针或取不到的项不返回，页面按「—」显示。 */
const pick = <T extends object>(row: T): T =>
  Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null)) as T;
/** safeText 按 UTF-16 截断，截在代理对中间时去掉留下的半个。 */
const text = (value: unknown, max: number) => {
  const cut = safeText(value, max);
  return (cut && /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut) || undefined;
};

function disks(value: unknown): EndpointDisk[] | null {
  if (!Array.isArray(value)) return null;
  const rows: EndpointDisk[] = [];
  for (const item of value.slice(0, MAX_DISKS)) {
    const r = rec(item);
    const mountpoint = text(r.mountpoint, 255);
    if (!mountpoint) continue;
    rows.push(
      pick({
        mountpoint,
        fsType: text(r.fs_type, 32),
        totalBytes: whole(r.total_bytes),
        freeBytes: whole(r.free_bytes),
        usedPct: count(r.used_pct),
      }),
    );
  }
  return rows;
}

function accelerators(value: unknown): EndpointAccelerator[] | null {
  if (!Array.isArray(value)) return null;
  const rows: EndpointAccelerator[] = [];
  for (const item of value.slice(0, MAX_ACCELERATORS)) {
    const r = rec(item);
    const vendor = text(r.vendor, 32);
    const model = text(r.model, 255);
    const source = text(r.source, 32);
    if (!vendor || !model || !source) continue;
    rows.push(
      pick({
        vendor,
        model,
        memoryMB: whole(r.memory_mb),
        driverVersion: text(r.driver_version, 64),
        index: whole(r.index),
        busId: text(r.bus_id, 32),
        source,
      }),
    );
  }
  return rows;
}

function aiComponents(value: unknown): EndpointAIComponent[] | null {
  if (!Array.isArray(value)) return null;
  const rows: EndpointAIComponent[] = [];
  for (const item of value.slice(0, MAX_AI_COMPONENTS)) {
    const r = rec(item);
    const id = text(r.id, 64);
    const name = text(r.name, 128);
    const category = text(r.category, 32);
    const source = text(r.source, 32);
    if (!id || !name || !category || !source) continue;
    rows.push(
      pick({
        id,
        name,
        category,
        version: text(r.version, 64),
        source,
        package: text(r.package, 128),
        env: text(r.env, 16),
      }),
    );
  }
  return rows;
}

/** 采集不完整的原因代码（accelerator_errors、ai_component_errors）：只留形如代码的字符串，去重；旧探针没有时为 null。 */
function errorCodes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const codes = value.filter((v): v is string => typeof v === 'string' && ERROR_CODE.test(v));
  return [...new Set(codes)].slice(0, MAX_ERROR_CODES);
}

/** 最近一次体检上报的主机快照；没有上报或报告里没有主机快照时返回 null。 */
export function endpointHardware(body: unknown): EndpointHardware | null {
  const host = rec(rec(body).host);
  if (Object.keys(host).length === 0) return null;
  return {
    collectedAt: safeText(host.hardware_collected_at, 40),
    os: safeText(host.os, 32),
    osVersion: safeText(host.os_version, 128),
    platform: safeText(host.platform, 64),
    platformVersion: safeText(host.platform_version, 64),
    kernelVersion: safeText(host.kernel_version, 128),
    arch: safeText(host.arch, 32),
    cpuModel: safeText(host.cpu_model, 255),
    cpuCores: whole(host.cpu_cores) ?? null,
    cpuCountLogical: whole(host.cpu_count_logical) ?? null,
    memoryTotalMB: whole(host.memory_total_mb) ?? null,
    disks: disks(host.disks),
    accelerators: accelerators(host.accelerators),
    acceleratorErrors: errorCodes(host.accelerator_errors),
    aiComponents: aiComponents(host.ai_components),
    aiComponentErrors: errorCodes(host.ai_component_errors),
  };
}
