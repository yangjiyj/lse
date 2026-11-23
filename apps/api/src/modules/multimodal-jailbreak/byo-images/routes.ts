import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../../db.js';
import { requirePermission } from '../../../plugins/auth.js';
import { requireLicensedFeature } from '../../../lib/license-enforcement.js';
import { badRequest, forbidden, notFound } from '../../../lib/errors.js';
import { writeAudit } from '../../../lib/audit.js';
import { enqueueEvalTask } from '../../../lib/queue.js';
import { assertNonEndpointTaskTarget } from '../../../lib/endpoint-task-policy.js';
import type { CurrentUser } from '../../../lib/rbac.js';
import { MULTIMODAL_ENGINE } from '../executor.js';
import {
  BYO_IMAGE_MAX_BYTES,
  BYO_MAX_IMAGES,
  BYO_ZIP_MAX_BYTES,
  validateByoArchive,
} from './archive.js';
import { BYO_EXPECTED_VALUES, BYO_MANIFEST_TEMPLATE } from './manifest.js';
import { BYO_QUESTION_KIND, BYO_SET_SOURCE, byoJudgeExpectation } from './executor.js';

export const BYO_VISION_REQUIRED_MESSAGE =
  '该评估对象未声明支持图片输入，无法发起多模态评估。请先在评估对象编辑页开启“支持图片输入”。';

/** 图片集只属于创建者；持有「更新系统设置」权限的管理员可代为查看与删除。 */
export function canAccessByoSet(user: CurrentUser, ownerId: string | null): boolean {
  return ownerId === user.id || user.permissions.has('system_setting:update');
}

export async function loadOwnedByoSet(user: CurrentUser, setId: string) {
  const set = await prisma.questionSet.findUnique({
    where: { id: setId },
    select: {
      id: true,
      name: true,
      source: true,
      createdById: true,
      metadata: true,
      _count: { select: { questions: true, taskLinks: true, byoImages: true } },
    },
  });
  if (!set || set.source !== BYO_SET_SOURCE) throw notFound('自带图片集不存在');
  // 不是自己的图片集一律按不存在处理，不泄露其存在。
  if (!canAccessByoSet(user, set.createdById)) throw notFound('自带图片集不存在');
  return set;
}

/** 只记数量与哈希摘要，不记图片内容与文件名。 */
export function byoAuditSummary(sha256s: readonly string[]) {
  const sorted = [...sha256s].sort();
  return {
    imageCount: sorted.length,
    sha256: sorted.slice(0, 50),
    digest: createHash('sha256').update(sorted.join('\n')).digest('hex'),
  };
}

/** 删除图片集下全部图片字节（含审计）；返回删除张数。 */
export async function purgeByoImages(
  setId: string,
  actor: { id: string; username: string } | null,
  reason: string,
): Promise<number> {
  const rows = await prisma.byoImage.findMany({
    where: { questionSetId: setId },
    select: { sha256: true },
  });
  if (rows.length === 0) return 0;
  await prisma.byoImage.deleteMany({ where: { questionSetId: setId } });
  const set = await prisma.questionSet.findUnique({
    where: { id: setId },
    select: { metadata: true },
  });
  if (set) {
    const md = (
      set.metadata && typeof set.metadata === 'object' && !Array.isArray(set.metadata)
        ? set.metadata
        : {}
    ) as Record<string, unknown>;
    await prisma.questionSet.update({
      where: { id: setId },
      data: {
        metadata: { ...md, imagesDeletedAt: new Date().toISOString() } as Prisma.InputJsonValue,
      },
    });
  }
  await writeAudit({
    actorId: actor?.id ?? null,
    actorName: actor?.username ?? null,
    action: 'multimodal_byo.images_delete',
    targetType: 'question_set',
    targetId: setId,
    detail: { reason, ...byoAuditSummary(rows.map((r) => r.sha256)) },
  });
  return rows.length;
}

const idParams = z.object({ id: z.string().uuid() });
const uploadQuery = z.object({ name: z.string().trim().min(1).max(100).optional() });
const createBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  modelTargetId: z.string().uuid(),
  byoImageSetId: z.string().uuid(),
});

/** 注册在 /api/eval-tasks 下：/multimodal/byo/*。 */
export function registerByoImageRoutes(app: FastifyInstance): void {
  for (const ct of ['application/octet-stream', 'application/zip']) {
    app.addContentTypeParser(
      ct,
      { parseAs: 'buffer', bodyLimit: BYO_ZIP_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
  }

  app.get(
    '/multimodal/byo/limits',
    { preHandler: [requirePermission('eval_task:read')] },
    async () => ({
      zipMaxBytes: BYO_ZIP_MAX_BYTES,
      imageMaxBytes: BYO_IMAGE_MAX_BYTES,
      maxImages: BYO_MAX_IMAGES,
      formats: ['png', 'jpg', 'jpeg', 'webp'],
      expectedValues: BYO_EXPECTED_VALUES,
    }),
  );

  app.get(
    '/multimodal/byo/manifest-template',
    { preHandler: [requirePermission('eval_task:read')] },
    async (_req, reply) => {
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', "attachment; filename*=UTF-8''manifest-template.csv")
        .header('cache-control', 'no-store');
      return reply.send('﻿' + BYO_MANIFEST_TEMPLATE);
    },
  );

  // 上传 zip：全部校验通过才入库（逐行中文报告）；失败不留任何数据。
  app.post(
    '/multimodal/byo/image-sets',
    {
      preHandler: [requirePermission('eval_task:create'), requireLicensedFeature('web_ai')],
      bodyLimit: BYO_ZIP_MAX_BYTES,
    },
    async (request, reply) => {
      const { name } = uploadQuery.parse(request.query);
      if (!Buffer.isBuffer(request.body)) {
        throw badRequest(
          '请以 application/zip 或 application/octet-stream 上传 zip 原始字节',
          'BYO_UPLOAD_TYPE',
        );
      }
      const result = await validateByoArchive(request.body);
      if (!result.ok) {
        await writeAudit({
          actorId: request.currentUser!.id,
          actorName: request.currentUser!.username,
          action: 'multimodal_byo.upload_rejected',
          targetType: 'question_set',
          detail: { issueCount: result.issues.length, zipBytes: result.stats.zipBytes },
        });
        throw badRequest(
          `自带图片集校验未通过，共 ${result.issues.length} 项问题，请按报告修正后重新上传`,
          'BYO_VALIDATION_FAILED',
          { issues: result.issues, warnings: result.warnings, stats: result.stats },
        );
      }
      const setName = name ?? `自带图片集 ${new Date().toISOString().slice(0, 16)}`;
      const created = await prisma.$transaction(
        async (tx) => {
          const set = await tx.questionSet.create({
            data: {
              name: setName,
              description: `客户自带图片集：${result.items.length} 题、${result.images.length} 张图片。图片由客户自行确认合法合规来源，评估完成后可一键删除。`,
              type: 'SHOULD_REFUSE',
              source: BYO_SET_SOURCE,
              language: 'zh',
              tags: ['multimodal-jailbreak', 'multimodal-byo'],
              createdById: request.currentUser!.id,
              metadata: { byo: true, imageCount: result.images.length },
            },
          });
          const idByKey = new Map<string, string>();
          for (const img of result.images) {
            const row = await tx.byoImage.create({
              data: {
                questionSetId: set.id,
                name: img.name,
                mimeType: img.mimeType,
                sha256: img.sha256,
                sizeBytes: img.sizeBytes,
                width: img.width,
                height: img.height,
                data: new Uint8Array(img.data),
              },
              select: { id: true },
            });
            idByKey.set(img.key, row.id);
          }
          for (const item of result.items) {
            const img = result.images.find((i) => i.key === item.imageKey)!;
            const exp = byoJudgeExpectation(item.expected);
            await tx.question.create({
              data: {
                questionSetId: set.id,
                content: item.prompt,
                type: exp.type,
                category: item.category || null,
                severity: item.expected === '应拒绝' ? 'HIGH' : 'MEDIUM',
                shouldRefuse: exp.shouldRefuse,
                expectedBehavior: exp.expectedBehavior,
                tags: ['multimodal-byo'],
                metadata: {
                  kind: BYO_QUESTION_KIND,
                  byo: {
                    imageId: idByKey.get(item.imageKey)!,
                    sha256: img.sha256,
                    imageName: img.name,
                    expected: item.expected,
                    category: item.category,
                    note: item.note,
                  },
                } satisfies Prisma.InputJsonValue,
              },
            });
          }
          return set;
        },
        { timeout: 120_000, maxWait: 20_000 },
      );
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'multimodal_byo.upload',
        targetType: 'question_set',
        targetId: created.id,
        detail: {
          questionCount: result.items.length,
          ...byoAuditSummary(result.images.map((i) => i.sha256)),
        },
      });
      reply.code(201);
      return {
        id: created.id,
        name: created.name,
        questionCount: result.items.length,
        imageCount: result.images.length,
        warnings: result.warnings,
        stats: result.stats,
      };
    },
  );

  app.get(
    '/multimodal/byo/image-sets/:id',
    { preHandler: [requirePermission('eval_task:read')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const set = await loadOwnedByoSet(request.currentUser!, id);
      return {
        id: set.id,
        name: set.name,
        questionCount: set._count.questions,
        imageCount: set._count.byoImages,
        taskCount: set._count.taskLinks,
        imagesDeleted: set._count.byoImages === 0,
      };
    },
  );

  // 一键删除图片：图片字节立即清除，题目与评测结论保留（结果里的原图将不可再查看）。
  app.delete(
    '/multimodal/byo/image-sets/:id/images',
    { preHandler: [requirePermission('eval_task:read')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const set = await loadOwnedByoSet(request.currentUser!, id);
      if (!canAccessByoSet(request.currentUser!, set.createdById)) throw forbidden();
      const deleted = await purgeByoImages(id, request.currentUser!, 'user_request');
      return { ok: true, deleted };
    },
  );

  // 评测完成后，按任务一键删除其使用的自带图片（题目与结论保留）。
  app.delete(
    '/:id/multimodal-byo-images',
    { preHandler: [requirePermission('eval_task:read')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const task = await prisma.evalTask.findUnique({
        where: { id },
        select: {
          questionSets: {
            select: { questionSet: { select: { id: true, source: true, createdById: true } } },
          },
        },
      });
      if (!task) throw notFound('评估任务不存在');
      const sets = task.questionSets
        .map((l) => l.questionSet)
        .filter(
          (q) =>
            q.source === BYO_SET_SOURCE && canAccessByoSet(request.currentUser!, q.createdById),
        );
      if (sets.length === 0) throw notFound('该任务没有可删除的自带图片');
      let deleted = 0;
      for (const set of sets) {
        deleted += await purgeByoImages(set.id, request.currentUser!, 'task_request');
      }
      return { ok: true, deleted };
    },
  );

  // 删除整个图片集（尚未被任务引用时）。
  app.delete(
    '/multimodal/byo/image-sets/:id',
    { preHandler: [requirePermission('eval_task:delete')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const set = await loadOwnedByoSet(request.currentUser!, id);
      if (set._count.taskLinks > 0) {
        throw badRequest(
          `该图片集已被 ${set._count.taskLinks} 个评估任务引用，请删除任务，或仅一键删除图片`,
          'BYO_SET_IN_USE',
        );
      }
      await purgeByoImages(id, request.currentUser!, 'set_delete');
      await prisma.questionSet.delete({ where: { id } });
      return { ok: true };
    },
  );

  // 用已上传的图片集创建多模态评估任务。
  app.post(
    '/multimodal/byo',
    { preHandler: [requirePermission('eval_task:create'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = createBody.parse(request.body);
      const target = await prisma.modelTarget.findUnique({ where: { id: body.modelTargetId } });
      if (!target) throw badRequest('所选评估对象不存在', 'MODEL_TARGET_NOT_FOUND');
      assertNonEndpointTaskTarget(target);
      if (!target.isActive) throw badRequest('所选评估对象已禁用', 'MODEL_TARGET_INACTIVE');
      if (target.targetType !== 'MODEL') {
        throw badRequest('多模态评估仅支持可直接调用的模型评估对象', 'MULTIMODAL_TARGET_NOT_MODEL');
      }
      if (!target.supportsVision) {
        throw badRequest(BYO_VISION_REQUIRED_MESSAGE, 'MULTIMODAL_VISION_NOT_SUPPORTED');
      }
      const set = await loadOwnedByoSet(request.currentUser!, body.byoImageSetId);
      if (set._count.questions === 0) throw badRequest('图片集内没有题目', 'BYO_SET_EMPTY');
      if (set._count.byoImages === 0) {
        throw badRequest('该图片集的图片已被删除，请重新上传', 'BYO_IMAGES_DELETED');
      }
      const taskName =
        body.name ?? `${target.name} 自带图片评估 ${new Date().toISOString().slice(0, 16)}`;
      const created = await prisma.evalTask.create({
        data: {
          name: taskName,
          description:
            '多模态评估（客户自带图片集）：将客户上传的图片与配套提问发送给视觉模型，由判定模型评估是否守住安全边界。',
          status: 'PENDING',
          modelTargetId: target.id,
          engines: [MULTIMODAL_ENGINE, 'llm-judge'],
          dimensions: ['multimodal_jailbreak'],
          concurrency: 2,
          totalQuestions: set._count.questions,
          createdById: request.currentUser!.id,
          questionSets: { create: [{ questionSetId: set.id }] },
        },
      });
      await enqueueEvalTask(created.id);
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'eval_task.create_multimodal_byo',
        targetType: 'eval_task',
        targetId: created.id,
        detail: {
          name: created.name,
          modelTargetId: target.id,
          questionSetId: set.id,
          questionCount: set._count.questions,
        },
      });
      reply.code(201);
      return { id: created.id, name: created.name, totalQuestions: set._count.questions };
    },
  );
}
