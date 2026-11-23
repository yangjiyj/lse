// 初始超级管理员凭证解析 —— 在 seed 阶段统一裁决账号口令来源。
//
// 安全约束（② 默认凭证生产 fail-fast）：
//   1. 生产环境（NODE_ENV=production）必须通过环境变量 ADMIN_PASSWORD 显式注入强口令；
//      未注入、或仍使用内置示例口令时，直接抛异常中止 seed，杜绝弱口令进生产。
//   2. 非生产环境为方便本地/CI，允许回退到内置开发默认口令，但调用方绝不应记录明文。
//   3. 返回 passwordSource 供调用方写安全日志（只标注来源，永不输出口令本身）。

/** 仅供本地 / CI 使用的开发默认口令；生产环境出现即视为未配置。 */
export const DEV_DEFAULT_PASSWORD = 'Admin@12345';

export interface AdminCredentials {
  username: string;
  password: string;
  displayName: string;
  /** 口令来源：env=运维显式注入；dev-default=内置开发默认（仅非生产允许）。 */
  passwordSource: 'env' | 'dev-default';
}

export function resolveAdminCredentials(env: NodeJS.ProcessEnv = process.env): AdminCredentials {
  const normalizedNodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  const isProduction = normalizedNodeEnv === 'production' || normalizedNodeEnv === 'prod';
  const username = env.ADMIN_USERNAME?.trim() || 'admin';
  const displayName = env.ADMIN_DISPLAY_NAME?.trim() || '超级管理员';
  const envPassword = env.ADMIN_PASSWORD?.trim();

  if (isProduction) {
    if (!envPassword) {
      throw new Error(
        '[seed] 生产环境必须通过环境变量 ADMIN_PASSWORD 显式设置初始管理员口令，禁止使用内置默认口令。',
      );
    }
    if (envPassword === DEV_DEFAULT_PASSWORD) {
      throw new Error(
        '[seed] 生产环境禁止使用内置示例口令（Admin@12345）作为初始管理员口令，请改用强口令。',
      );
    }
    return { username, password: envPassword, displayName, passwordSource: 'env' };
  }

  if (envPassword) {
    return { username, password: envPassword, displayName, passwordSource: 'env' };
  }
  return { username, password: DEV_DEFAULT_PASSWORD, displayName, passwordSource: 'dev-default' };
}
