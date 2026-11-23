import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthUser, LoginResponse } from '@lse/shared';
import { prisma, prismaUnscoped } from '../../db.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { loadCurrentUser, type CurrentUser } from '../../lib/rbac.js';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../../lib/errors.js';
import {
  formatRemaining,
  isPasswordChangeRequired,
  isPasswordExpired,
  loadSecurityPolicy,
  passwordExpiresAt,
  passwordPolicyViolation,
  type SecuritySettings,
} from '../../lib/security-policy.js';
import { writeAudit } from '../../lib/audit.js';
import { authenticate } from '../../plugins/auth.js';
import {
  enforcePublicRateLimit,
  incrementWindow,
  tooManyRequests,
  warnPublicRedis,
} from '../../lib/public-rate-limit.js';
import { PLATFORM_TENANT_ID } from '../../lib/tenant-models.js';
import { usernameSchema } from '../users/routes.js';

const loginSchema = z.object({
  username: z.string().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码'),
});

const registerSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1, '请输入姓名').max(32, '姓名最多 32 字'),
  phone: z
    .string()
    .trim()
    .regex(/^1\d{10}$/, '手机号格式不正确'),
  organization: z.string().trim().min(1, '请输入单位').max(64, '单位最多 64 字'),
  password: z.string().min(1, '请输入密码').max(128, '密码过长'),
});

/** 同一 IP 一小时内最多尝试注册的次数（重名、参数错误也算）。 */
const REGISTER_PER_HOUR = 5;

/** 注册用户归属的租户：按安全策略配置，没配或租户已删除时归平台租户。 */
async function registrationTenantId(policy: SecuritySettings): Promise<string> {
  const wanted = policy.registrationTenantId;
  if (wanted) {
    const tenant = await prismaUnscoped.tenant.findUnique({ where: { id: wanted } });
    if (tenant) return tenant.id;
  }
  return PLATFORM_TENANT_ID;
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(1, '请输入新密码').max(128, '新密码过长'),
});

export function toAuthUser(user: CurrentUser, policy?: SecuritySettings): AuthUser {
  const expiresAt = policy ? passwordExpiresAt(user.passwordChangedAt, policy) : null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    isBuiltin: user.isBuiltin,
    roles: user.roles,
    permissions: [...user.permissions].sort(),
    preferences: user.preferences ?? {},
    passwordExpired: policy ? isPasswordExpired(user.passwordChangedAt, policy) : false,
    passwordChangeRequired: policy
      ? isPasswordChangeRequired(user.mustChangePassword, policy)
      : false,
    passwordExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    idleTimeoutMinutes: policy?.idleTimeoutMinutes ?? 0,
    auditLogAccess: policy?.auditLogAccess ?? 'admins_and_auditors',
    tenant: user.allTenants
      ? { id: 'all', name: '全部租户', isPlatform: true }
      : { id: user.tenantId, name: user.tenantName, isPlatform: user.tenantIsPlatform },
    homeTenantId: user.homeTenantId,
    isPlatformAdmin: user.isPlatformAdmin,
    allTenants: user.allTenants,
  };
}

function accountLocked(until: Date): AppError {
  return new AppError(
    403,
    `账户已被锁定，剩余锁定时间 ${formatRemaining(until.getTime() - Date.now())}`,
    'ACCOUNT_LOCKED',
    { lockedUntil: until.toISOString() },
  );
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/login', async (request) => {
    const { username, password } = loginSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) throw unauthorized('用户名或密码错误', 'INVALID_CREDENTIALS');
    // 锁定与失败计数对未启用的账号（含待审核）同样生效，否则待审核账号可以被无限次猜密码。
    const policy = await loadSecurityPolicy();
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw accountLocked(user.lockedUntil);
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      // 锁定已过期的账户重新从 0 计数。
      const base = user.lockedUntil ? 0 : user.failedLoginCount;
      const failedLoginCount = base + 1;
      const max = policy.maxFailedLoginAttempts;
      if (max > 0 && failedLoginCount >= max) {
        const lockedUntil = new Date(Date.now() + policy.lockoutMinutes * 60_000);
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginCount, lockedUntil },
        });
        await writeAudit({
          actorId: user.id,
          actorName: user.username,
          action: 'auth.account_locked',
          targetType: 'user',
          targetId: user.id,
          detail: { failedLoginCount, lockoutMinutes: policy.lockoutMinutes },
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        throw accountLocked(lockedUntil);
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount, lockedUntil: null },
      });
      await writeAudit({
        actorId: user.id,
        actorName: user.username,
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: user.id,
        detail: { failedLoginCount },
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      const left = max > 0 ? `，再失败 ${max - failedLoginCount} 次将锁定账户` : '';
      throw unauthorized(`用户名或密码错误${left}`, 'INVALID_CREDENTIALS');
    }
    if (!user.isActive) {
      // 密码对了，连续失败次数清零（与启用账号登录成功时一致）。
      if (user.failedLoginCount > 0 || user.lockedUntil) {
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginCount: 0, lockedUntil: null },
        });
      }
      // 密码正确才告诉对方账号待审核；被拒绝、被停用的一律按用户名或密码错误处理。
      if (user.registrationStatus === 'PENDING') {
        throw unauthorized('账号待审核，请等待管理员审核通过', 'ACCOUNT_PENDING');
      }
      throw unauthorized('用户名或密码错误', 'INVALID_CREDENTIALS');
    }
    const tenantCheck = await loadCurrentUser(user.id);
    if (tenantCheck && !tenantCheck.homeTenantActive && !tenantCheck.isPlatformAdmin) {
      throw forbidden('所在租户已停用，请联系平台管理员', 'TENANT_DISABLED');
    }
    const now = new Date();
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: now, lastActiveAt: now, failedLoginCount: 0, lockedUntil: null },
    });
    const current = await loadCurrentUser(user.id);
    const token = app.jwt.sign({ sub: user.id, username: user.username });
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'auth.login',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    const body: LoginResponse = { token, user: toAuthUser(current!, policy) };
    return body;
  });

  // 自助注册（免登录）：安全策略里开了注册才可用；注册后待管理员审核，审核前不能登录。
  app.post('/register', async (request, reply) => {
    await enforcePublicRateLimit('register', request.ip);
    const policy = await loadSecurityPolicy();
    if (!policy.registrationEnabled) throw forbidden('未开放注册', 'REGISTRATION_DISABLED');
    // 先计数再判断：并发请求不会一起穿过额度；重名、参数错误同样消耗额度。
    let attempts: number;
    try {
      attempts = await incrementWindow(`register:${request.ip}`, 3600);
    } catch (err) {
      warnPublicRedis(err);
      throw new AppError(503, '注册暂不可用，请稍后再试', 'REGISTRATION_UNAVAILABLE');
    }
    if (attempts > REGISTER_PER_HOUR) throw tooManyRequests('注册过于频繁，请一小时后再试');
    const body = registerSchema.parse(request.body);
    const violation = passwordPolicyViolation(body.password, policy);
    if (violation) throw badRequest(violation, 'PASSWORD_POLICY');
    const taken = await prismaUnscoped.user.findFirst({
      where: { username: { equals: body.username, mode: 'insensitive' } },
      select: { id: true },
    });
    if (taken) throw conflict('用户名已存在', 'USERNAME_TAKEN');
    const tenantId = await registrationTenantId(policy);
    const user = await prismaUnscoped.user.create({
      data: {
        tenantId,
        username: body.username,
        passwordHash: await hashPassword(body.password),
        displayName: body.displayName,
        phone: body.phone,
        organization: body.organization,
        isActive: false,
        registrationStatus: 'PENDING',
      },
    });
    await writeAudit({
      tenantId,
      actorId: user.id,
      actorName: user.username,
      action: 'auth.register',
      targetType: 'user',
      targetId: user.id,
      detail: { username: user.username, organization: user.organization },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    reply.code(201);
    return { ok: true };
  });

  app.get('/me', { preHandler: [authenticate] }, async (request) => {
    return { user: toAuthUser(request.currentUser!, await loadSecurityPolicy()) };
  });

  // 当前生效的密码策略：改密弹窗据此动态提示规则（需登录，不含敏感信息）。
  app.get('/password-policy', { preHandler: [authenticate] }, async () => {
    const p = await loadSecurityPolicy();
    return {
      passwordMinLength: p.passwordMinLength,
      passwordRequireUppercase: p.passwordRequireUppercase,
      passwordRequireLowercase: p.passwordRequireLowercase,
      passwordRequireDigit: p.passwordRequireDigit,
      passwordRequireSpecial: p.passwordRequireSpecial,
      passwordExpireDays: p.passwordExpireDays,
    };
  });

  // 当前登录用户自助修改自己的密码：必须校验当前密码，区别于管理员重置（不校验旧密码）。
  app.post('/me/password', { preHandler: [authenticate] }, async (request) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(request.body);
    const userId = request.currentUser!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw unauthorized('用户不存在或已被删除');
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw unauthorized('当前密码错误', 'INVALID_CURRENT_PASSWORD');
    }
    const violation = passwordPolicyViolation(newPassword, await loadSecurityPolicy());
    if (violation) throw badRequest(violation, 'PASSWORD_POLICY');
    if (await verifyPassword(user.passwordHash, newPassword)) {
      throw badRequest('新密码不能与当前密码相同', 'SAME_PASSWORD');
    }
    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, passwordChangedAt: new Date(), mustChangePassword: false },
    });
    await writeAudit({
      actorId: userId,
      actorName: request.currentUser!.username,
      action: 'auth.change_password',
      targetType: 'user',
      targetId: userId,
      ip: request.ip,
    });
    return { ok: true };
  });

  const patchPreferencesSchema = z
    .object({
      viewMode: z.enum(['expert', 'demo']).optional(),
    })
    .strict();

  app.patch('/me/preferences', { preHandler: [authenticate] }, async (request) => {
    const body = patchPreferencesSchema.parse(request.body);
    const userId = request.currentUser!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw unauthorized('用户不存在或已被删除');
    const current = (user.preferences ?? {}) as Record<string, unknown>;
    const next = { ...current, ...body };
    await prisma.user.update({
      where: { id: userId },
      data: { preferences: next },
    });
    const fresh = await loadCurrentUser(userId);
    return { user: toAuthUser(fresh!, await loadSecurityPolicy()) };
  });

  app.post('/logout', { preHandler: [authenticate] }, async (request) => {
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'auth.logout',
      ip: request.ip,
    });
    return { ok: true };
  });
}
