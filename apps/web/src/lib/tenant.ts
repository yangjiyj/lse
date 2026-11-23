import type { AuthUser } from './api';

/**
 * 当前是否在平台租户里操作。网关联动、网关日志、策略下发、智能体安全平台终端来源这些依赖全平台共用集成的功能，
 * 这一期只给平台租户：其他租户（含平台管理员代管时）界面上不出现这些入口。
 * 没有租户信息时按平台处理（单租户部署、旧接口）。
 */
export function isPlatformTenantUser(user: Pick<AuthUser, 'tenant'> | null | undefined): boolean {
  return user?.tenant?.isPlatform !== false;
}
