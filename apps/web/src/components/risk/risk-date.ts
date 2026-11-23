/** 风险发现统一按平台所在地北京时间展示，避免 UTC 午夜附近错日。 */
export function riskDate(value: string, short = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return `${short ? '' : `${part('year')}-`}${part('month')}-${part('day')}`;
}
