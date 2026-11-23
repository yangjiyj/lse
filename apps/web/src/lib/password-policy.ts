import type { PasswordPolicy, PasswordRulePolicy } from './api';

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  passwordMinLength: 8,
  passwordRequireUppercase: false,
  passwordRequireLowercase: false,
  passwordRequireDigit: false,
  passwordRequireSpecial: false,
  passwordExpireDays: 0,
};

export interface PasswordRule {
  label: string;
  ok: boolean;
}

/** 按安全设置生成密码规则清单（与后端 passwordPolicyViolation 同一口径）。 */
export function passwordRules(password: string, policy: PasswordRulePolicy): PasswordRule[] {
  const rules: PasswordRule[] = [
    {
      label: `长度至少 ${policy.passwordMinLength} 位`,
      ok: password.length >= policy.passwordMinLength,
    },
  ];
  if (policy.passwordRequireUppercase) {
    rules.push({ label: '包含大写字母', ok: /[A-Z]/.test(password) });
  }
  if (policy.passwordRequireLowercase) {
    rules.push({ label: '包含小写字母', ok: /[a-z]/.test(password) });
  }
  if (policy.passwordRequireDigit) rules.push({ label: '包含数字', ok: /[0-9]/.test(password) });
  if (policy.passwordRequireSpecial) {
    rules.push({ label: '包含特殊字符', ok: /[^A-Za-z0-9]/.test(password) });
  }
  return rules;
}

export function passwordSatisfies(password: string, policy: PasswordRulePolicy): boolean {
  return password.length <= 128 && passwordRules(password, policy).every((r) => r.ok);
}
