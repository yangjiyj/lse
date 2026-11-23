import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../db.js';
import {
  listScannerScopePolicies,
  parseScannerScopePolicy,
  ScannerScopeError,
  type ScannerScopePolicy,
} from '../../lib/scanner-scope.js';

export const SERVICE_ASSURANCE_SCOPE_SETTING_KEY = 'service_assurance.scope_policies';

const refSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const serviceAssuranceScopePolicyInputSchema = z
  .object({
    ref: refSchema,
    name: z.string().trim().min(1).max(120),
    origins: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
    cidrs: z.array(z.string().trim().min(1).max(100)).min(1).max(64),
    allowPrivate: z.boolean(),
    allowPublic: z.boolean(),
    isDefault: z.boolean(),
  })
  .strict();

export const serviceAssuranceScopeSettingsInputSchema = z
  .object({ policies: z.array(serviceAssuranceScopePolicyInputSchema).max(50) })
  .strict();

const storedSchema = z
  .object({
    version: z.literal(1),
    policies: z.array(serviceAssuranceScopePolicyInputSchema).max(50),
  })
  .strict();

export type ServiceAssuranceScopePolicyInput = z.infer<
  typeof serviceAssuranceScopePolicyInputSchema
>;

export interface ServiceAssuranceScopeSettings {
  policies: ServiceAssuranceScopePolicyInput[];
  defaultPolicyRef: string | null;
  managedByPlatform: boolean;
  updatedAt: string | null;
}

export function scopePolicySnapshot(policy: ScannerScopePolicy): ScannerScopePolicy {
  return {
    ref: policy.ref,
    origins: [...new Set(policy.origins)].sort(),
    cidrs: [...new Set(policy.cidrs)].sort(),
    allowPrivate: policy.allowPrivate,
    allowPublic: policy.allowPublic,
  };
}

export function scopePolicyDigest(policy: ScannerScopePolicy): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(scopePolicySnapshot(policy)))
    .digest('hex')}`;
}

export function parseScopePolicySnapshot(
  ref: string,
  value: unknown,
  expectedDigest: string | null,
): ScannerScopePolicy {
  const policy = parseScannerScopePolicy(ref, value);
  if (!expectedDigest || scopePolicyDigest(policy) !== expectedDigest) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '核验任务的授权范围快照校验失败');
  }
  return policy;
}

function normalizePolicies(
  inputs: ServiceAssuranceScopePolicyInput[],
): ServiceAssuranceScopePolicyInput[] {
  const seen = new Set<string>();
  let defaultCount = 0;
  const policies = inputs.map((input) => {
    if (seen.has(input.ref)) {
      throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '范围策略引用不能重复');
    }
    seen.add(input.ref);
    if (input.isDefault) defaultCount += 1;
    const normalized = parseScannerScopePolicy(input.ref, {
      ref: input.ref,
      origins: input.origins,
      cidrs: input.cidrs,
      allowPrivate: input.allowPrivate,
      allowPublic: input.allowPublic,
    });
    return {
      ...normalized,
      name: input.name,
      isDefault: input.isDefault,
    };
  });
  if (policies.length > 0 && defaultCount !== 1) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '必须且只能设置一个默认范围策略');
  }
  return policies;
}

function fromEnvironment(env: NodeJS.ProcessEnv): ServiceAssuranceScopeSettings {
  const rawPolicies = listScannerScopePolicies(env);
  const preferred = env.SERVICE_ASSURANCE_DEFAULT_SCOPE_POLICY_REF?.trim();
  const defaultRef = rawPolicies.some((policy) => policy.ref === preferred)
    ? preferred!
    : (rawPolicies.find((policy) => policy.ref === 'default')?.ref ?? rawPolicies[0]?.ref ?? null);
  return {
    policies: rawPolicies.map((policy) => ({
      ...policy,
      name: policy.ref,
      isDefault: policy.ref === defaultRef,
    })),
    defaultPolicyRef: defaultRef,
    managedByPlatform: false,
    updatedAt: null,
  };
}

export async function loadServiceAssuranceScopeSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceAssuranceScopeSettings> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: SERVICE_ASSURANCE_SCOPE_SETTING_KEY },
  });
  if (!row) return fromEnvironment(env);
  let stored: z.infer<typeof storedSchema>;
  try {
    stored = storedSchema.parse(row.value);
  } catch {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '平台保存的范围策略格式无效');
  }
  const policies = normalizePolicies(stored.policies);
  return {
    policies,
    defaultPolicyRef: policies.find((policy) => policy.isDefault)?.ref ?? null,
    managedByPlatform: true,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function saveServiceAssuranceScopeSettings(
  input: z.infer<typeof serviceAssuranceScopeSettingsInputSchema>,
  updatedById: string,
): Promise<ServiceAssuranceScopeSettings> {
  const policies = normalizePolicies(
    serviceAssuranceScopeSettingsInputSchema.parse(input).policies,
  );
  const value = { version: 1, policies } as unknown as Prisma.InputJsonObject;
  const row = await prisma.systemSetting.upsert({
    where: { key: SERVICE_ASSURANCE_SCOPE_SETTING_KEY },
    create: { key: SERVICE_ASSURANCE_SCOPE_SETTING_KEY, value, updatedById },
    update: { value, updatedById },
  });
  return {
    policies,
    defaultPolicyRef: policies.find((policy) => policy.isDefault)?.ref ?? null,
    managedByPlatform: true,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function resolveManagedScopePolicy(ref: string): Promise<ScannerScopePolicy> {
  const settings = await loadServiceAssuranceScopeSettings();
  const policy = settings.policies.find((item) => item.ref === ref);
  if (!policy) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_NOT_FOUND', '指定的扫描范围策略不存在');
  }
  return parseScannerScopePolicy(ref, {
    ref: policy.ref,
    origins: policy.origins,
    cidrs: policy.cidrs,
    allowPrivate: policy.allowPrivate,
    allowPublic: policy.allowPublic,
  });
}
