import { useEffect, useSyncExternalStore } from 'react';
import { api, type DataSecurityStatus } from '@/lib/api';

/**
 * 数据安全开关的全局 store（不依赖 QueryClient，便于在 AppShell 等任意位置使用）。
 * 未加载或加载失败时按最严格默认值处理：脱敏开启、水印开启、无查看明文权限。
 */
export const SAFE_DATA_SECURITY: DataSecurityStatus = {
  maskSensitive: true,
  downloadWatermark: true,
  pageWatermark: true,
  canViewPlain: false,
};

let current: DataSecurityStatus = SAFE_DATA_SECURITY;
let inflight: Promise<void> | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setDataSecurity(next: Partial<DataSecurityStatus>): void {
  current = { ...current, ...next };
  emit();
}

/** 拉取最新开关与当前用户是否可查看明文；force 用于登录用户切换或设置保存后刷新。 */
export function loadDataSecurity(force = false): Promise<void> {
  if (inflight) return inflight;
  if (loaded && !force) return Promise.resolve();
  inflight = (async () => {
    try {
      const res = await api.dataSecurity.get();
      if (res) setDataSecurity(res);
    } catch {
      // 保持当前（默认最严格）值
    } finally {
      loaded = true;
      inflight = null;
    }
  })();
  return inflight;
}

export function useDataSecurity(): DataSecurityStatus {
  const value = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
  useEffect(() => {
    void loadDataSecurity();
  }, []);
  return value;
}

export function resetDataSecurityForTest(): void {
  current = SAFE_DATA_SECURITY;
  loaded = false;
  inflight = null;
  emit();
}
