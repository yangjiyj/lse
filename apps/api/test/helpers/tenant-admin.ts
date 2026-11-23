import { prismaUnscoped } from '../../src/db.js';

/**
 * 新建租户时，首个管理员带「须改密」标记，登录后只能改密（2.9.8）。
 * 业务测试要直接拿这个账号调接口时，先用它清掉标记；改密流程本身在 auth-force-password-change 里测。
 */
export async function skipFirstPasswordChange(username: string): Promise<void> {
  await prismaUnscoped.user.update({ where: { username }, data: { mustChangePassword: false } });
}
