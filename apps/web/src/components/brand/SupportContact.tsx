import { useBranding } from '@/lib/branding';
import { cn } from '@/lib/utils';

/** 登录页底部「技术支持：单位 · 联系人 · 电话」，没填的项不显示，全空时整行不显示。 */
export function SupportContact({ className }: { className?: string }) {
  const { supportOrg, contactName, contactPhone } = useBranding();
  const parts = [supportOrg, contactName, contactPhone].filter((v): v is string => !!v);
  if (parts.length === 0) return null;
  return (
    <p className={cn('text-[12.5px] text-ink-3', className)}>{`技术支持：${parts.join(' · ')}`}</p>
  );
}
