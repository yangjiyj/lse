import { useEffect, useMemo } from 'react';
import { useAuth } from '@/lib/auth';
import { useBranding } from '@/lib/branding';
import { loadDataSecurity, useDataSecurity } from '@/lib/data-security';

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 第 16 条数据安全：前端页面水印层（用户名 + 时间），不拦截鼠标事件。 */
export function PageWatermark() {
  const { user } = useAuth();
  const ds = useDataSecurity();
  const { platformTitle } = useBranding();
  // 登录用户切换时刷新「查看明文」权限与开关
  useEffect(() => {
    if (user?.username) void loadDataSecurity(true);
  }, [user?.username]);
  const text = user ? `${user.username} ${today()}` : '';
  const background = useMemo(() => {
    if (!text) return '';
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    // 560×340 平铺、-24°、单色、不透明度约 4.5%–5%：截图取证仍可识别，但不抢占表格阅读。
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="340">` +
      `<g transform="rotate(-24 280 170)" fill="#1E3A8A" font-family="PingFang SC,Microsoft YaHei,sans-serif">` +
      `<text x="60" y="165" fill-opacity="0.05" font-size="15" font-weight="600">${esc(text)}</text>` +
      `<text x="60" y="188" fill-opacity="0.045" font-size="13">${esc(platformTitle)}</text></g></svg>`;
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  }, [text, platformTitle]);

  if (!ds.pageWatermark || !text) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="page-watermark"
      data-watermark={text}
      className="pointer-events-none fixed inset-0 z-[60] select-none"
      style={{ backgroundImage: background, backgroundRepeat: 'repeat' }}
    />
  );
}
