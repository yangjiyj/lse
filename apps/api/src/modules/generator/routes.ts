import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { LANGUAGE, QUESTION_TYPE, SEVERITY } from '@lse/shared';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, permissionDenied } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { ALL_PATTERNS } from './templates/index.js';
import { generate } from './core/generate.js';
import { specSignature } from './core/signature.js';
import type { GenerateSpec } from './core/types.js';
import { enhance } from './enhance/enhance.js';
import {
  buildEnhanceConfigFromEnv,
  createEnhanceLlmClient,
  isEnhanceConfigured,
} from './enhance/llm-client.js';
import { ENHANCE_MODES, type EnhanceSpec } from './enhance/types.js';
import {
  CUSTOMER_DATA_FIELD_KINDS,
  CUSTOMER_DATA_SCENARIO_IDS,
  customerDataSpecSignature,
  generateCustomerDataLeakageQuestions,
  type CustomerDataLeakageSpec,
} from './customer-data.js';

const generateLanguageSchema = z.union([z.enum(LANGUAGE), z.literal('auto')]);
const variantStrengthSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal('auto'),
]);

const enhanceSchema = z.object({
  mode: z.enum(ENHANCE_MODES),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  language: z.enum(LANGUAGE).optional(),
  sampleLimit: z.coerce.number().int().min(1).max(20).optional(),
});

const specSchema = z.object({
  types: z.array(z.enum(QUESTION_TYPE)).min(1),
  categories: z.array(z.string().trim().min(1).max(60)).optional(),
  language: generateLanguageSchema.default('auto'),
  count: z.coerce.number().int().min(1).max(2000).default(50),
  variantStrength: variantStrengthSchema.optional(),
  seed: z.string().trim().max(120).optional(),
  dedupe: z.boolean().default(true),
  enhance: enhanceSchema.optional(),
});

const generateSchema = specSchema.extend({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});

const customerDataFieldSchema = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(CUSTOMER_DATA_FIELD_KINDS).default('custom'),
  description: z.string().trim().max(160).optional(),
  examples: z.array(z.string().trim().min(1).max(160)).max(5).optional(),
  sensitivity: z.enum(SEVERITY).optional(),
});

const customerDataSpecSchema = z.object({
  datasetName: z.string().trim().min(1).max(120),
  fields: z.array(customerDataFieldSchema).min(1).max(100),
  count: z.coerce.number().int().min(1).max(1000).default(100),
  seed: z.string().trim().max(120).optional(),
  language: z.enum(['zh', 'en']).default('zh'),
  scenarios: z.array(z.enum(CUSTOMER_DATA_SCENARIO_IDS)).min(1).optional(),
});

const customerDataGenerateSchema = customerDataSpecSchema.extend({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});

type ParsedSpecBody = z.infer<typeof specSchema>;
type ParsedCustomerDataSpecBody = z.infer<typeof customerDataSpecSchema>;

function toGenerateSpec(body: ParsedSpecBody): GenerateSpec {
  return {
    types: body.types,
    categories: body.categories,
    language: body.language,
    count: body.count,
    variantStrength: body.variantStrength,
    seed: body.seed,
    dedupe: body.dedupe,
  };
}

function toCustomerDataSpec(body: ParsedCustomerDataSpecBody): CustomerDataLeakageSpec {
  return {
    datasetName: body.datasetName,
    fields: body.fields,
    count: body.count,
    seed: body.seed,
    language: body.language,
    scenarios: body.scenarios,
  };
}

function buildCustomerDataSetMetadata(
  outcome: ReturnType<typeof generateCustomerDataLeakageQuestions>,
) {
  const languages = uniqueSorted(outcome.questions.map((q) => q.language));
  const setLanguage = languages.length === 1 ? languages[0]! : 'multi';
  const tags = new Set<string>(['gen:customer-data', 'risk:data_leakage', `lang:${setLanguage}`]);
  for (const item of outcome.diversity.scenarios) tags.add(`scenario:${item.key}`);
  for (const item of outcome.diversity.fieldKinds) tags.add(`field-kind:${item.key}`);
  for (const item of outcome.diversity.riskDomains) tags.add(`risk:${item.key}`);
  return { language: setLanguage, tags: [...tags] };
}

function requireEnhancePermission(request: FastifyRequest, spec: EnhanceSpec | undefined): void {
  if (spec && !request.currentUser!.permissions.has('generator:llm')) {
    throw permissionDenied(['generator:llm']);
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function effectiveVariantStrength(spec: GenerateSpec): GenerateSpec['variantStrength'] {
  return spec.variantStrength ?? (!spec.language || spec.language === 'auto' ? 'auto' : 0);
}

function buildSetMetadata(spec: GenerateSpec, outcome: ReturnType<typeof generate>) {
  const languages = uniqueSorted(outcome.questions.map((q) => q.language));
  const setLanguage = languages.length === 1 ? languages[0]! : 'multi';
  const tags = new Set<string>(['gen:algo', `lang:${setLanguage}`]);
  const autoDiverse =
    !spec.language || spec.language === 'auto' || effectiveVariantStrength(spec) === 'auto';
  if (autoDiverse) tags.add('gen:auto-diverse');
  if (setLanguage === 'multi') {
    for (const language of languages) tags.add(`lang:${language}`);
  }
  for (const item of outcome.diversity.riskDomains) tags.add(`risk:${item.key}`);
  for (const item of outcome.diversity.variants) tags.add(`variant:${item.key}`);
  return { language: setLanguage, tags: [...tags] };
}

function buildEnhanceRuntime() {
  const cfg = buildEnhanceConfigFromEnv(process.env);
  const configured = isEnhanceConfigured(cfg);
  return {
    configured,
    client: configured ? createEnhanceLlmClient(cfg) : null,
  };
}

export async function generatorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.post(
    '/customer-data/preview',
    { preHandler: [requirePermission('generator:preview'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const body = customerDataSpecSchema.parse(request.body);
      const outcome = generateCustomerDataLeakageQuestions(toCustomerDataSpec(body));
      return {
        requested: outcome.requested,
        produced: outcome.produced,
        capacityCeiling: outcome.capacityCeiling,
        samples: outcome.questions.slice(0, 20),
        diversity: outcome.diversity,
      };
    },
  );

  app.post(
    '/customer-data/generate',
    { preHandler: [requirePermission('generator:run'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = customerDataGenerateSchema.parse(request.body);
      const spec: CustomerDataLeakageSpec = {
        ...toCustomerDataSpec(body),
        seed: body.seed ?? randomUUID(),
      };
      const outcome = generateCustomerDataLeakageQuestions(spec);
      if (outcome.produced === 0) {
        throw badRequest('当前数据蓝图未生成有效测试样本。', 'CUSTOMER_DATA_GENERATE_EMPTY');
      }

      const source = `customer-data-generator:${customerDataSpecSignature(spec)}`;
      const metadata = buildCustomerDataSetMetadata(outcome);
      const created = await prisma.$transaction(async (tx) => {
        const set = await tx.questionSet.create({
          data: {
            name: body.name,
            description: body.description,
            type: 'COMPLIANCE',
            language: metadata.language,
            tags: metadata.tags,
            source,
            createdById: request.currentUser!.id,
          },
        });
        await tx.question.createMany({
          data: outcome.questions.map((q) => ({
            questionSetId: set.id,
            externalId: q.externalId,
            content: q.content,
            category: q.category,
            expectedBehavior: q.expectedBehavior,
            referenceAnswer: q.referenceAnswer,
            type: q.type,
            severity: q.severity,
            shouldRefuse: q.shouldRefuse,
            tags: q.tags,
            language: q.language,
            metadata: q.metadata as Prisma.InputJsonValue,
          })),
        });
        return set;
      });

      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'generator.customer_data.generate',
        targetType: 'question_set',
        targetId: created.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        detail: {
          requested: outcome.requested,
          produced: outcome.produced,
          language: spec.language ?? 'zh',
          datasetName: spec.datasetName,
          fieldCount: spec.fields.length,
          source,
          tags: metadata.tags,
          diversity: outcome.diversity,
        },
      });

      reply.code(201);
      return {
        questionSetId: created.id,
        requested: outcome.requested,
        produced: outcome.produced,
        capacityCeiling: outcome.capacityCeiling,
        seed: spec.seed,
        diversity: outcome.diversity,
      };
    },
  );

  app.post(
    '/preview',
    { preHandler: [requirePermission('generator:preview'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const body = specSchema.parse(request.body);
      requireEnhancePermission(request, body.enhance);
      const outcome = generate(ALL_PATTERNS, toGenerateSpec(body));
      const previewLimit = body.enhance?.sampleLimit ?? 10;
      const runtime = buildEnhanceRuntime();
      const enhanced = await enhance(outcome.questions.slice(0, previewLimit), {
        spec: body.enhance,
        client: runtime.client,
        configured: runtime.configured,
      });

      return {
        requested: outcome.requested,
        produced: outcome.produced,
        capacityCeiling: outcome.capacityCeiling,
        samples: outcome.questions.slice(0, 20),
        enhancement: enhanced.stats,
        enhancedSamples: enhanced.samples,
        diversity: outcome.diversity,
      };
    },
  );

  app.post(
    '/generate',
    { preHandler: [requirePermission('generator:run'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = generateSchema.parse(request.body);
      requireEnhancePermission(request, body.enhance);
      const spec: GenerateSpec = {
        ...toGenerateSpec(body),
        seed: body.seed ?? randomUUID(),
      };
      const outcome = generate(ALL_PATTERNS, spec);
      if (outcome.produced === 0) {
        throw badRequest('所选条件下没有可用模板，未生成测试样本。', 'GENERATE_EMPTY');
      }

      const runtime = buildEnhanceRuntime();
      const enhanced = await enhance(outcome.questions, {
        spec: body.enhance,
        client: runtime.client,
        configured: runtime.configured,
      });
      const questions = enhanced.questions;

      const setType = body.types.length === 1 ? body.types[0] : 'GENERAL';
      const source = `generator:${specSignature(spec)}`;
      const metadata = buildSetMetadata(spec, outcome);

      const created = await prisma.$transaction(async (tx) => {
        const set = await tx.questionSet.create({
          data: {
            name: body.name,
            description: body.description,
            type: setType,
            language: metadata.language,
            tags: metadata.tags,
            source,
            createdById: request.currentUser!.id,
          },
        });
        await tx.question.createMany({
          data: questions.map((q) => ({
            questionSetId: set.id,
            externalId: q.externalId,
            content: q.content,
            category: q.category,
            expectedBehavior: q.expectedBehavior,
            referenceAnswer: q.referenceAnswer,
            type: q.type,
            severity: q.severity,
            shouldRefuse: q.shouldRefuse,
            tags: q.tags,
            language: q.language,
          })),
        });
        return set;
      });

      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'generator.generate',
        targetType: 'question_set',
        targetId: created.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        detail: {
          requested: outcome.requested,
          produced: outcome.produced,
          language: spec.language ?? 'auto',
          variantStrength: effectiveVariantStrength(spec),
          types: spec.types,
          source,
          tags: metadata.tags,
          diversity: outcome.diversity,
          enhancement: enhanced.stats,
        },
      });

      if (body.enhance) {
        await writeAudit({
          actorId: request.currentUser!.id,
          actorName: request.currentUser!.username,
          action: 'generator.enhance',
          targetType: 'question_set',
          targetId: created.id,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          detail: { spec: body.enhance, stats: enhanced.stats },
        });
      }

      reply.code(201);
      return {
        questionSetId: created.id,
        requested: outcome.requested,
        produced: outcome.produced,
        capacityCeiling: outcome.capacityCeiling,
        seed: spec.seed,
        enhancement: enhanced.stats,
        diversity: outcome.diversity,
      };
    },
  );
}
