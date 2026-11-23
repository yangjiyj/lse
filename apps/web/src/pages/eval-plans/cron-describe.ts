/**
 * cron 表达式的中文说明（5 段：分 时 日 月 周）。
 * 只翻译常见写法；识别不了的返回「自定义：<原表达式>」，不做猜测。
 * 下次执行时间以后端按时区计算的 nextRunAt 为准，这里只做文字说明。
 */
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const isInt = (v: string) => /^\d+$/.test(v);
const pad = (v: string) => v.padStart(2, '0');

function weekdays(field: string): string | null {
  if (field === '1-5') return '工作日';
  if (field === '0,6' || field === '6,0') return '周末';
  const parts = field.split(',');
  if (!parts.every((p) => isInt(p) && Number(p) >= 0 && Number(p) <= 7)) return null;
  return parts.map((p) => WEEKDAY[Number(p) % 7]).join('、');
}

export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  const custom = `自定义：${cron.trim()}`;
  if (fields.length !== 5) return custom;
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  if (mon !== '*') return custom;

  const step = /^\*\/(\d+)$/;
  const minStep = step.exec(min);
  if (minStep && hour === '*' && dom === '*' && dow === '*') return `每 ${minStep[1]} 分钟`;
  const hourStep = step.exec(hour);
  if (isInt(min) && hourStep && dom === '*' && dow === '*') {
    return `每 ${hourStep[1]} 小时（第 ${min} 分）`;
  }
  if (isInt(min) && hour === '*' && dom === '*' && dow === '*') return `每小时第 ${min} 分`;
  if (!isInt(min) || !isInt(hour)) return custom;

  const time = `${pad(hour)}:${pad(min)}`;
  if (dom === '*' && dow === '*') return `每天 ${time}`;
  if (dom === '*') {
    const w = weekdays(dow);
    return w ? `每${w === '工作日' || w === '周末' ? '个' : ''}${w} ${time}` : custom;
  }
  if (dow === '*' && isInt(dom)) return `每月 ${Number(dom)} 日 ${time}`;
  return custom;
}
