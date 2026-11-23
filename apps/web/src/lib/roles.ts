/** 内置角色在界面上一律显示中文名；自建角色按起的名字显示。 */
export const BUILTIN_ROLE_LABELS: Record<string, string> = {
  admin: '平台管理员',
  tenant_admin: '租户管理员',
  operator: '评估操作员',
  auditor: '审计员',
};

export function roleLabel(name: string): string {
  return BUILTIN_ROLE_LABELS[name] ?? name;
}
