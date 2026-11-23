import type { FastifyInstance } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { requestLoginAddresses } from './access-address.js';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../db.js';
import { AppError, badRequest, forbidden, permissionDenied } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { RED_TEAM_SETTING_KEY } from '../red-team/config.js';
import {
  RED_TEAM_DEFAULT_ROUNDS,
  RED_TEAM_MAX_ROUNDS_LIMIT,
  RED_TEAM_MIN_ROUNDS,
  normalizeRedTeamMaxRounds,
} from '@lse/shared';
import { assertCallableRedTeamTarget } from '../red-team/target-validation.js';
import { asSystem } from '../../lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../../lib/tenant-models.js';
import { AGENT_EVAL_SETTING_KEY } from '../agent-evals/config.js';
import { assertControlPlaneAllowed, resolveInternalToken } from '../../lib/gateway-access.js';
import { randomBytes } from 'node:crypto';
import {
  fetchGatewayHealth,
  fetchGatewayVerifyReciprocal,
  gatewayReciprocityMessage,
} from '../gateway-logs/client.js';
import {
  SECURITY_SETTING_KEY,
  invalidateSecurityPolicyCache,
  parseStoredSecurity,
  securitySchema,
  type SecuritySettings,
} from '../../lib/security-policy.js';
import {
  TENANT_SETTING_KEY,
  parseStoredTenant,
  tenantSchema,
  mergeTenant,
  type TenantSettings,
} from '../../lib/tenant-branding.js';
import {
  EVALUATION_SETTING_KEY,
  mergeEvaluation,
  parseStoredEvaluation,
  type EvaluationSettings,
} from '../../lib/evaluation-config.js';
import {
  DATA_SECURITY_SETTING_KEY,
  dataSecuritySchema,
  parseStoredDataSecurity,
  type DataSecuritySettings,
} from '../../lib/data-security.js';

const settingGroups = [
  'access',
  'audit',
  'gateway',
  'redteam',
  'agent_eval',
  'security',
  'tenant',
  'evaluation',
  'data_security',
] as const;
type SettingGroup = (typeof settingGroups)[number];

const PLATFORM_GROUPS: ReadonlySet<SettingGroup> = new Set([
  'access',
  'audit',
  'gateway',
  'security',
  'tenant',
  'evaluation',
  'data_security',
]);
const REDTEAM_GROUPS: ReadonlySet<SettingGroup> = new Set(['redteam', 'agent_eval']);

function assertGroupPermission(
  request: { currentUser?: { permissions: Set<string> } },
  group: SettingGroup,
): void {
  const user = request.currentUser;
  if (!user) throw forbidden();
  const isPlatform = PLATFORM_GROUPS.has(group);
  const specific = isPlatform ? 'platform_setting:update' : 'redteam_setting:update';
  if (user.permissions.has(specific) || user.permissions.has('system_setting:update')) return;
  throw permissionDenied([specific]);
}

/** 兜底：字段名像密钥的一律不进审计详情。 */
const SECRET_FIELD_RE = /secret|token|api_?key|private_?key|credential/i;

/** 变化了的字段及前后值，供审计详情使用（只用于不含密钥的分组，如安全设置）。 */
function changedFields<T extends object>(
  before: T,
  after: T,
): Record<string, { before: unknown; after: unknown }> {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(after) as Array<keyof T & string>) {
    if (SECRET_FIELD_RE.test(key) || before[key] === after[key]) continue;
    changes[key] = { before: before[key], after: after[key] };
  }
  return changes;
}

// 分组名 → systemSetting 表的实际存储键。红队配置由 red-team 模块以 'redteam.config' 键持有,
// Agent 评估配置以 'agent_eval.config' 键持有,与分组名不同,故需此映射桥接。
const KEY_BY_GROUP: Record<SettingGroup, string> = {
  access: 'access',
  audit: 'audit',
  gateway: 'gateway',
  redteam: RED_TEAM_SETTING_KEY,
  agent_eval: AGENT_EVAL_SETTING_KEY,
  security: SECURITY_SETTING_KEY,
  tenant: TENANT_SETTING_KEY,
  evaluation: EVALUATION_SETTING_KEY,
  data_security: DATA_SECURITY_SETTING_KEY,
};

const accessSchema = z.object({
  encryptedLoginUrl: z.string().trim().max(300),
  compatibleLoginUrl: z.string().trim().max(300),
  loginPolicy: z.string().trim().min(1).max(120),
  sessionPolicy: z.string().trim().min(1).max(120),
});

const auditSchema = z.object({
  operationAudit: z.boolean(),
  evidenceRetention: z.string().trim().min(1).max(120),
  logRedaction: z.string().trim().min(1).max(120),
  retentionDays: z.coerce.number().int().min(1).max(3650),
  externalArchive: z.boolean(),
  archiveTarget: z.string().trim().max(300).default(''),
});

const gatewaySchema = z.object({
  gatewayBaseUrl: z.string().trim().max(300).default(''),
  gatewayLinkageEnabled: z.boolean().default(false),
});

const redteamSchema = z.object({
  gatewayTargetId: z.string().trim().max(200).default(''),
  attackerTargetId: z.string().trim().max(200).default(''),
  secondaryAttackerTargetId: z.string().trim().max(200).default(''),
  judgeTargetId: z.string().trim().max(200).default(''),
  breakOn: z.enum(['verdict', 'attitude']).default('verdict'),
  maxRounds: z.coerce
    .number()
    .int()
    .min(RED_TEAM_MIN_ROUNDS)
    .max(RED_TEAM_MAX_ROUNDS_LIMIT)
    .default(RED_TEAM_DEFAULT_ROUNDS),
  noProgressK: z.coerce.number().int().min(1).max(20).default(3),
  // 预算闸与总局数上限：红队运行时实际消费的字段（react-attacker / executor.maxLaps），
  // 作为 schema 一等字段持久化，替代早期 passthrough 兜底。
  budgetTokens: z.coerce.number().int().min(0).nullable().default(null),
  maxLaps: z.coerce.number().int().min(0).nullable().default(null),
  moves: z.array(z.string()).optional(),
});

const agentEvalSchema = z
  .object({
    attackerTargetId: z.string().trim().max(200).default(''),
    judgeTargetId: z.string().trim().max(200).default(''),
    adaptiveRounds: z.coerce.number().int().min(0).max(8).default(2),
    noProgressK: z.coerce.number().int().min(1).max(20).default(3),
    enabled: z.boolean().default(false),
    fanoutEnabled: z.boolean().default(false),
  })
  .passthrough();

type AccessSettings = z.infer<typeof accessSchema>;
type AuditSettings = z.infer<typeof auditSchema>;
type GatewaySettings = z.infer<typeof gatewaySchema>;
type GatewayAddressAuthorization = 'NOT_CONFIGURED' | 'AUTHORIZED' | 'NOT_AUTHORIZED' | 'INVALID';
type RedTeamSettings = z.infer<typeof redteamSchema>;
type AgentEvalSettings = z.infer<typeof agentEvalSchema>;

interface SystemSettingsPayload {
  access: AccessSettings;
  audit: AuditSettings;
  gateway: GatewaySettings & {
    secretConfigured: boolean;
    addressAuthorization: GatewayAddressAuthorization;
  };
  redteam: RedTeamSettings;
  agent_eval: AgentEvalSettings;
  security: SecuritySettings;
  tenant: TenantSettings;
  evaluation: EvaluationSettings;
  data_security: DataSecuritySettings;
  updatedAt: Record<SettingGroup, string | null>;
}

async function assertRoleModelReferences(
  redteam: RedTeamSettings,
  agentEval: AgentEvalSettings,
): Promise<void> {
  const references: Array<{ id: string; role: 'attacker' | 'judge' }> = [
    { id: redteam.attackerTargetId, role: 'attacker' },
    { id: redteam.secondaryAttackerTargetId, role: 'attacker' },
    { id: redteam.judgeTargetId, role: 'judge' },
    { id: agentEval.attackerTargetId, role: 'attacker' },
    { id: agentEval.judgeTargetId, role: 'judge' },
  ];
  const populatedReferences = references.filter((reference) => reference.id.length > 0);
  if (populatedReferences.length === 0) return;

  // 平台设置是全局配置：引用校验必须跨租户读（asSystem），
  // 并要求被引用的对象属于平台租户或为平台共享，不能把某个租户的私有对象存成全平台配置。
  const targets = await asSystem(async () =>
    prisma.modelTarget.findMany({
      where: { id: { in: [...new Set(populatedReferences.map((reference) => reference.id))] } },
      select: {
        id: true,
        tenantId: true,
        targetType: true,
        isActive: true,
        baseUrl: true,
        apiKey: true,
        model: true,
      },
    }),
  );
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  for (const reference of populatedReferences) {
    const target = targetsById.get(reference.id);
    if (target && target.tenantId && target.tenantId !== PLATFORM_TENANT_ID) {
      throw badRequest(
        '只能引用平台内置或平台租户的模型对象，请先在平台租户里创建',
        'TENANT_REFERENCE',
      );
    }
    assertCallableRedTeamTarget(target, reference.role);
  }
}

const defaultSettings: {
  access: AccessSettings;
  audit: AuditSettings;
  gateway: GatewaySettings;
  redteam: RedTeamSettings;
  agent_eval: AgentEvalSettings;
} = {
  access: {
    encryptedLoginUrl: '',
    compatibleLoginUrl: '',
    loginPolicy: '保留兼容入口，引导使用加密入口',
    sessionPolicy: '签名会话令牌与权限校验',
  },
  audit: {
    operationAudit: true,
    evidenceRetention: '请求、响应与判定结果',
    logRedaction: '按规则脱敏',
    retentionDays: 180,
    externalArchive: false,
    archiveTarget: '',
  },
  gateway: {
    gatewayBaseUrl: '',
    gatewayLinkageEnabled: false,
  },
  redteam: {
    gatewayTargetId: '',
    attackerTargetId: '',
    secondaryAttackerTargetId: '',
    judgeTargetId: '',
    breakOn: 'verdict',
    maxRounds: RED_TEAM_DEFAULT_ROUNDS,
    noProgressK: 3,
    budgetTokens: null,
    maxLaps: null,
  },
  agent_eval: {
    attackerTargetId: '',
    judgeTargetId: '',
    adaptiveRounds: 2,
    noProgressK: 3,
    enabled: false,
    fanoutEnabled: false,
  },
};

const patchSchema = z
  .object({
    access: accessSchema.partial().optional(),
    audit: auditSchema.partial().optional(),
    gateway: gatewaySchema.partial().optional(),
    redteam: redteamSchema.partial().optional(),
    agent_eval: agentEvalSchema.partial().optional(),
    security: securitySchema.partial().optional(),
    tenant: tenantSchema.partial().optional(),
    evaluation: z
      .object({
        dimensionWeights: z.record(z.string(), z.number()),
        questionCount: z.number(),
        scoreWeights: z.record(z.string(), z.number()),
      })
      .partial()
      .optional(),
    data_security: dataSecuritySchema.partial().optional(),
  })
  .strict()
  .refine(
    (body) =>
      Boolean(
        body.access ||
        body.audit ||
        body.gateway ||
        body.redteam ||
        body.agent_eval ||
        body.security ||
        body.tenant ||
        body.evaluation ||
        body.data_security,
      ),
    {
      message: '至少提交一个配置分组',
    },
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseStoredAccess(value: unknown, headers: IncomingHttpHeaders): AccessSettings {
  const stored = isRecord(value) ? { ...value } : {};
  // 旧模板地址视为未配置；已保存的自定义地址始终优先，不回写推导结果。
  for (const key of ['encryptedLoginUrl', 'compatibleLoginUrl']) {
    if (typeof stored[key] === 'string' && stored[key].includes('<部署主机>')) delete stored[key];
  }
  return accessSchema.parse({
    ...defaultSettings.access,
    ...requestLoginAddresses(headers),
    ...stored,
  });
}

function parseStoredAudit(value: unknown): AuditSettings {
  return auditSchema.parse({
    ...defaultSettings.audit,
    ...(isRecord(value) ? value : {}),
  });
}

function parseStoredGateway(value: unknown): GatewaySettings {
  return gatewaySchema.parse({
    ...defaultSettings.gateway,
    ...(isRecord(value) ? value : {}),
  });
}

function parseStoredRedTeam(value: unknown): RedTeamSettings {
  const stored = isRecord(value) ? value : {};
  return redteamSchema.parse({
    ...defaultSettings.redteam,
    ...stored,
    // 旧版本允许 1–4 轮：兼容读取历史配置，提升到实战对抗最小轮数。
    maxRounds: normalizeRedTeamMaxRounds(stored.maxRounds ?? defaultSettings.redteam.maxRounds),
  });
}

export function gatewayControlPlaneBaseUrl(base: string): string {
  let input = base.trim();
  if (!/^https?:\/\//i.test(input)) input = `http://${input}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw badRequest('网关地址格式非法，请填写 IP、域名或 http(s) 地址');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw badRequest('网关地址格式非法，请填写 IP、域名或 http(s) 地址');
  }
  if (!url.port) url.host = `${url.hostname}:8080`;
  return `${url.protocol}//${url.host}/admin/v1`;
}

function gatewayAddressAuthorization(base: string): GatewayAddressAuthorization {
  if (!base.trim()) return 'NOT_CONFIGURED';
  try {
    assertControlPlaneAllowed(gatewayControlPlaneBaseUrl(base));
    return 'AUTHORIZED';
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 400) return 'INVALID';
    return 'NOT_AUTHORIZED';
  }
}

function assertGatewayAddressAuthorized(base: string): void {
  if (!base.trim()) return;
  const controlPlaneBaseUrl = gatewayControlPlaneBaseUrl(base);
  try {
    assertControlPlaneAllowed(controlPlaneBaseUrl);
  } catch (err) {
    if (err instanceof AppError && err.code === 'GATEWAY_CONTROL_PLANE_NOT_ALLOWED') {
      throw forbidden(
        `当前网关地址未获部署授权：${new URL(controlPlaneBaseUrl).origin}。请联系部署管理员授权后重试`,
        'GATEWAY_ADDRESS_NOT_AUTHORIZED',
      );
    }
    throw err;
  }
}

function parseStoredAgentEval(value: unknown): AgentEvalSettings {
  return agentEvalSchema.parse({
    ...defaultSettings.agent_eval,
    ...(isRecord(value) ? value : {}),
  });
}

async function readSystemSettings(
  headers: IncomingHttpHeaders = {},
): Promise<SystemSettingsPayload> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: Object.values(KEY_BY_GROUP) } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const updatedAtFor = (group: SettingGroup): string | null =>
    byKey.get(KEY_BY_GROUP[group])?.updatedAt.toISOString() ?? null;

  const gateway = parseStoredGateway(byKey.get(KEY_BY_GROUP.gateway)?.value);
  return {
    access: parseStoredAccess(byKey.get(KEY_BY_GROUP.access)?.value, headers),
    audit: parseStoredAudit(byKey.get(KEY_BY_GROUP.audit)?.value),
    gateway: {
      ...gateway,
      secretConfigured: Boolean((process.env.NEWAPI_EVAL_INTEGRATION_TOKEN ?? '').trim()),
      addressAuthorization: gatewayAddressAuthorization(gateway.gatewayBaseUrl),
    },
    redteam: parseStoredRedTeam(byKey.get(KEY_BY_GROUP.redteam)?.value),
    agent_eval: parseStoredAgentEval(byKey.get(KEY_BY_GROUP.agent_eval)?.value),
    security: parseStoredSecurity(byKey.get(KEY_BY_GROUP.security)?.value),
    tenant: parseStoredTenant(byKey.get(KEY_BY_GROUP.tenant)?.value),
    evaluation: parseStoredEvaluation(byKey.get(KEY_BY_GROUP.evaluation)?.value),
    data_security: parseStoredDataSecurity(byKey.get(KEY_BY_GROUP.data_security)?.value),
    updatedAt: {
      access: updatedAtFor('access'),
      audit: updatedAtFor('audit'),
      gateway: updatedAtFor('gateway'),
      redteam: updatedAtFor('redteam'),
      agent_eval: updatedAtFor('agent_eval'),
      security: updatedAtFor('security'),
      tenant: updatedAtFor('tenant'),
      evaluation: updatedAtFor('evaluation'),
      data_security: updatedAtFor('data_security'),
    },
  };
}

export async function systemSettingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get(
    '/',
    {
      preHandler: [
        requirePermission(
          'system_setting:read',
          'platform_setting:read',
          'redteam_setting:read',
          'license:read',
        ),
      ],
    },
    async (request) => readSystemSettings(request.headers),
  );

  app.patch(
    '/',
    {
      preHandler: [
        requirePermission(
          'system_setting:update',
          'platform_setting:update',
          'redteam_setting:update',
          'license:update',
        ),
      ],
    },
    async (request) => {
      const body = patchSchema.parse(request.body);
      const submittedGroups = settingGroups.filter((g) => body[g] !== undefined);
      for (const g of submittedGroups) assertGroupPermission(request, g);
      const current = await readSystemSettings(request.headers);
      let effectiveRedteam = current.redteam;
      let effectiveAgentEval = current.agent_eval;
      const updates: Array<
        [
          SettingGroup,
          (
            | AccessSettings
            | AuditSettings
            | GatewaySettings
            | RedTeamSettings
            | AgentEvalSettings
            | SecuritySettings
            | TenantSettings
            | EvaluationSettings
            | DataSecuritySettings
          ),
        ]
      > = [];

      if (body.access)
        updates.push(['access', accessSchema.parse({ ...current.access, ...body.access })]);
      if (body.audit)
        updates.push(['audit', auditSchema.parse({ ...current.audit, ...body.audit })]);
      if (body.gateway) {
        const gateway = gatewaySchema.parse({ ...current.gateway, ...body.gateway });
        assertGatewayAddressAuthorized(gateway.gatewayBaseUrl);
        updates.push(['gateway', gateway]);
      }
      if (body.redteam) {
        const mergedRedteam = redteamSchema.parse({ ...current.redteam, ...body.redteam });
        // 合并后整体校验：主出招 AI 必须非空，否则自主红队任务会在运行时
        // resolveRedTeamConfig 抛「缺少 attackerTargetId」并被软化成全题 ERROR。
        // 早拒比运行时报错更可观察、可修正。
        if (mergedRedteam.attackerTargetId.length === 0) {
          throw badRequest('请选择主攻击模型后再保存对抗评估配置。');
        }
        effectiveRedteam = mergedRedteam;
        updates.push(['redteam', mergedRedteam]);
      }
      if (body.agent_eval) {
        effectiveAgentEval = agentEvalSchema.parse({ ...current.agent_eval, ...body.agent_eval });
        updates.push(['agent_eval', effectiveAgentEval]);
      }

      if (body.security) {
        const security = securitySchema.parse({ ...current.security, ...body.security });
        if (
          body.security.registrationTenantId &&
          !(await prismaUnscoped.tenant.findUnique({
            where: { id: body.security.registrationTenantId },
          }))
        ) {
          throw badRequest('注册用户归属的租户不存在', 'REGISTRATION_TENANT_NOT_FOUND');
        }
        updates.push(['security', security]);
      }

      if (body.tenant) updates.push(['tenant', mergeTenant(current.tenant, body.tenant)]);
      if (body.evaluation) {
        updates.push([
          'evaluation',
          mergeEvaluation(current.evaluation, body.evaluation as Partial<EvaluationSettings>),
        ]);
      }

      if (body.data_security) {
        updates.push([
          'data_security',
          dataSecuritySchema.parse({ ...current.data_security, ...body.data_security }),
        ]);
      }

      if (updates.length === 0) throw badRequest('至少提交一个配置分组');
      if (body.redteam || body.agent_eval) {
        await assertRoleModelReferences(effectiveRedteam, effectiveAgentEval);
      }

      await prisma.$transaction(
        updates.map(([group, value]) => {
          const key = KEY_BY_GROUP[group];
          const jsonValue = value as unknown as Prisma.InputJsonValue;
          return prisma.systemSetting.upsert({
            where: { key },
            update: { value: jsonValue, updatedById: request.currentUser!.id },
            create: { key, value: jsonValue, updatedById: request.currentUser!.id },
          });
        }),
      );

      invalidateSecurityPolicyCache();
      const nextSecurity = updates.find(([group]) => group === 'security')?.[1] as
        | SecuritySettings
        | undefined;
      const securityChanges = nextSecurity ? changedFields(current.security, nextSecurity) : {};
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'system_setting.update',
        targetType: 'system_setting',
        detail: {
          // 字段名不能含 key：审计写入时会把名字含 key 的字段当密钥打码
          groups: updates.map(([group]) => group),
          ...(Object.keys(securityChanges).length > 0
            ? { changes: { security: securityChanges } }
            : {}),
        },
      });

      return readSystemSettings(request.headers);
    },
  );

  // 网关连通自检：带集成密钥与网关握手（与网关侧「测试连接」对称）。密钥取自部署环境，不在此填写。
  app.post(
    '/gateway/test',
    {
      preHandler: [requirePermission('system_setting:update', 'platform_setting:update')],
    },
    async (request) => {
      const body = z
        .object({ gatewayBaseUrl: z.string().trim().optional() })
        .parse(request.body ?? {});
      let base = body.gatewayBaseUrl?.trim() ?? '';
      if (!base) base = (await readSystemSettings()).gateway.gatewayBaseUrl;
      if (!base) return { ok: false, message: '未填写网关控制台地址' };
      try {
        const controlPlaneBaseUrl = gatewayControlPlaneBaseUrl(base);
        assertControlPlaneAllowed(controlPlaneBaseUrl);
        const tenantId = process.env.NEWAPI_TENANT_ID?.trim() || 'tenant_default';
        const internalToken = resolveInternalToken();
        const health = await fetchGatewayHealth({ controlPlaneBaseUrl, tenantId, internalToken });
        if (!health.ok) {
          return { ok: false, message: health.error ?? '连接失败', latencyMs: health.latencyMs };
        }
        // 互证：让网关用它配置的 LSE 地址回连本平台并回显 nonce，证明双向真实可达且指向本实例。
        const nonce = randomBytes(16).toString('hex');
        const verify = await fetchGatewayVerifyReciprocal({
          controlPlaneBaseUrl,
          tenantId,
          internalToken,
          nonce,
        });
        if (!verify.ok) {
          return {
            ok: false,
            message: verify.error ?? '双向校验失败',
            latencyMs: verify.latencyMs,
          };
        }
        if (!verify.reciprocal || verify.nonceEchoed !== nonce) {
          return {
            ok: false,
            message: verify.reciprocal
              ? '网关回连到的并非当前平台实例，请核对网关侧地址'
              : gatewayReciprocityMessage(verify.reason),
            latencyMs: verify.latencyMs,
          };
        }
        return { ok: true, message: '双方互通已验证', latencyMs: verify.latencyMs };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : '测试失败' };
      }
    },
  );
}
