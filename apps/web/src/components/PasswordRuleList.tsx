import { Check, X } from 'lucide-react';
import type { PasswordRule } from '@/lib/password-policy';

/** 密码规则清单：逐条显示是否满足（改密弹窗、注册页共用）。 */
export function PasswordRuleList({ rules }: { rules: PasswordRule[] }) {
  return (
    <ul aria-label="密码强度要求" className="space-y-1 text-xs">
      {rules.map((rule) => (
        <li
          key={rule.label}
          className={
            rule.ok
              ? 'flex items-center gap-1.5 text-emerald-700'
              : 'flex items-center gap-1.5 text-slate-500'
          }
        >
          {rule.ok ? (
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {rule.label}
          <span className="sr-only">{rule.ok ? '（已满足）' : '（未满足）'}</span>
        </li>
      ))}
    </ul>
  );
}
