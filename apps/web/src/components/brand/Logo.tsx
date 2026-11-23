import { useId } from 'react';
import { cn } from '@/lib/utils';
import { DEFAULT_PLATFORM_TITLE, useBranding } from '@/lib/branding';
import { PRODUCT_FULL_NAME, PRODUCT_NAME, PRODUCT_NAME_EN } from '@/lib/product-name';

const SHIELD = 'M16 2.4 L27.2 6.6 V15.4 C27.2 22 22.6 27.6 16 29.7 C9.4 27.6 4.8 22 4.8 15.4 V6.6 Z';

interface LogoMarkProps {
  size?: number;
  className?: string;
  /** 无障碍名称；装饰性使用（旁边已有文字）时传空串。 */
  title?: string;
}

/** 方向 B 品牌标志：蓝色渐变盾牌 + 三根上升评估条（内联 SVG，24/32/64px 均清晰）。 */
export function LogoMark({ size = 32, className, title = PRODUCT_NAME }: LogoMarkProps) {
  const gid = useId().replace(/:/g, '');
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={cn('shrink-0', className)}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      <defs>
        <linearGradient id={`lg${gid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4C8DFF" />
          <stop offset="1" stopColor="#1B45C4" />
        </linearGradient>
      </defs>
      <path d={SHIELD} fill={`url(#lg${gid})`} />
      <rect x="9.6" y="17.4" width="3.4" height="5.6" rx="1.2" fill="#fff" opacity=".78" />
      <rect x="14.3" y="13.4" width="3.4" height="9.6" rx="1.2" fill="#fff" opacity=".9" />
      <rect x="19" y="9.4" width="3.4" height="13.6" rx="1.2" fill="#fff" />
    </svg>
  );
}

/** 单色版：线性盾牌 + 三条评估线，随 currentColor 着色，供水印、报告页眉与打印使用。 */
export function LogoMono({ size = 32, className, title = '' }: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={cn('shrink-0', className)}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      <path d={SHIELD} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M10.4 22.6 V18.2 M16 22.6 V14.2 M21.6 22.6 V10.2" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

interface BrandLogoProps {
  /** 图标边长，默认 32 */
  size?: number;
  /** 名称字号 class */
  nameClassName?: string;
  /** 是否显示中文全称副标（仅默认标题时生效） */
  showSubtitle?: boolean;
  /** 名称是否渲染为页面 h1（登录页使用） */
  asHeading?: boolean;
  className?: string;
}

/**
 * 白牌兼容的品牌锁定：租户配置了 logo / 标题则显示租户的；
 * 否则显示默认盾牌与品牌名（PRODUCT_NAME）+ 中文全称副标（PRODUCT_FULL_NAME）；英文副标作 title。仅默认标题时显示副标。
 */
export function BrandLogo({ size = 32, nameClassName, showSubtitle = true, asHeading = false, className }: BrandLogoProps) {
  const branding = useBranding();
  const NameTag = asHeading ? 'h1' : 'span';
  const customTitle = branding.platformTitle !== DEFAULT_PLATFORM_TITLE;
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      {branding.platformLogo ? (
        <img
          src={branding.platformLogo}
          alt=""
          style={{ width: size, height: size }}
          className="shrink-0 rounded-[8px] object-contain"
        />
      ) : (
        <LogoMark size={size} title="" />
      )}
      <span className="flex min-w-0 flex-col leading-tight">
        <NameTag className={cn('truncate font-bold tracking-[0.02em] text-ink', nameClassName)} title={customTitle ? branding.platformTitle : `${PRODUCT_NAME} ${PRODUCT_NAME_EN}`}>
          {customTitle ? branding.platformTitle : PRODUCT_NAME}
        </NameTag>
        {showSubtitle && !customTitle && (
          <span className="mt-0.5 truncate text-[10px] tracking-[0.12em] text-[#64748B]" title={PRODUCT_NAME_EN}>
            {PRODUCT_FULL_NAME}
          </span>
        )}
      </span>
    </span>
  );
}
