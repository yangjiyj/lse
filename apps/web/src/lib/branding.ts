import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_PLATFORM_TITLE_TEXT, PRODUCT_NAME } from './product-name';

// 租户信息设置（平台 logo、页签 logo、平台标题、技术支持联系方式）的前端落地：
// 登录前即从公开只读接口 /api/branding 拉取，作用于登录页、侧边栏、浏览器页签标题与 favicon。

export const DEFAULT_PLATFORM_TITLE = DEFAULT_PLATFORM_TITLE_TEXT;

/** 技术支持单位与联系人（登录页底部展示），没填为 null。 */
export const SUPPORT_CONTACT_KEYS = [
  'supportOrg',
  'contactName',
  'contactPhone',
  'contactEmail',
] as const;
type SupportContactKey = (typeof SUPPORT_CONTACT_KEYS)[number];

export interface Branding extends Record<SupportContactKey, string | null> {
  platformTitle: string;
  platformLogo: string | null;
  tabLogo: string | null;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';
const DEFAULT_BRANDING: Branding = {
  platformTitle: DEFAULT_PLATFORM_TITLE,
  platformLogo: null,
  tabLogo: null,
  supportOrg: null,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
};

function contactValue(next: unknown, prev: string | null): string | null {
  if (next === undefined) return prev;
  return typeof next === 'string' && next.trim() ? next.trim() : null;
}

let current: Branding = DEFAULT_BRANDING;
/** 当前页面名（取自导航配置）；为空时页签只显示平台标题。 */
let pageName: string | null = null;
let loaded = false;
const listeners = new Set<() => void>();

/** 只接受 PNG/JPG/ICO/WEBP 的 data URL（后端已校验，这里再兜底，杜绝 SVG / javascript: 等）。 */
export function safeLogo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^data:image\/(png|jpeg|x-icon|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
}

/**
 * 页签标题：有页面名时为「页面名 · 品牌名」，否则就是平台标题。
 * 品牌名在默认标题下用 PRODUCT_NAME，租户改了平台标题则用租户自己的，避免白牌场景露出产品名。
 */
export function composeDocumentTitle(platformTitle: string, page: string | null): string {
  if (!page) return platformTitle;
  const brand = platformTitle === DEFAULT_PLATFORM_TITLE ? PRODUCT_NAME : platformTitle;
  return `${page} · ${brand}`;
}

function applyDocument(b: Branding): void {
  if (typeof document === 'undefined') return;
  document.title = composeDocumentTitle(b.platformTitle, pageName);
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (b.tabLogo) {
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = b.tabLogo;
  } else if (link) {
    link.remove();
  }
}

/** 更新品牌信息（保存设置后调用即可实时生效）。 */
export function setBranding(next: Partial<Branding>): void {
  current = {
    platformTitle: next.platformTitle?.trim() || current.platformTitle,
    platformLogo:
      next.platformLogo === undefined ? current.platformLogo : safeLogo(next.platformLogo),
    tabLogo: next.tabLogo === undefined ? current.tabLogo : safeLogo(next.tabLogo),
    supportOrg: contactValue(next.supportOrg, current.supportOrg),
    contactName: contactValue(next.contactName, current.contactName),
    contactPhone: contactValue(next.contactPhone, current.contactPhone),
    contactEmail: contactValue(next.contactEmail, current.contactEmail),
  };
  applyDocument(current);
  for (const l of listeners) l();
}

/** 设置当前页面名并刷新页签标题；传 null 回到只显示平台标题。 */
export function setPageName(name: string | null): void {
  pageName = name;
  applyDocument(current);
}

export async function loadBranding(): Promise<void> {
  loaded = true;
  try {
    const res = await fetch(`${API_BASE}/branding`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = (await res.json()) as Partial<Branding>;
    setBranding({
      platformTitle: data.platformTitle ?? DEFAULT_PLATFORM_TITLE,
      platformLogo: data.platformLogo ?? null,
      tabLogo: data.tabLogo ?? null,
      ...Object.fromEntries(SUPPORT_CONTACT_KEYS.map((key) => [key, data[key] ?? null])),
    });
  } catch {
    // 品牌接口不可用时保留默认标题
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBranding(): Branding {
  const value = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
  useEffect(() => {
    if (!loaded) void loadBranding();
  }, []);
  return value;
}

/** 仅测试用：重置到默认值。 */
export function resetBrandingForTest(): void {
  loaded = true;
  pageName = null;
  current = DEFAULT_BRANDING;
  applyDocument(current);
  for (const l of listeners) l();
}
