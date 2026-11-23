import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { tenantFilterWhere } from '../../lib/all-tenants.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { REPORT_OPTIONAL_SECTIONS } from './labels.js';
import { REPORT_EVIDENCE_DETAILS } from './report-template.js';

// 报告模板接口 /api/report-templates（2.4.7）：读要 report:read，写要 report_template:manage。

const READ = { preHandler: [requirePermission('report:read')] };
const MANAGE = { preHandler: [requirePermission('report_template:manage')] };

const idParams = z.object({ id: z.string().uuid() });
// 控制字符（含 NUL）不能进模板：会进页眉页脚、封面和 Word 的 XML。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const noControl = <S extends z.ZodString>(s: S) =>
  s.refine((v) => !CONTROL_CHARS.test(v), { message: '不能包含控制字符' });
const text = (max: number) => noControl(z.string().trim().max(max));
const fields = {
  name: noControl(z.string().trim().min(1).max(100)),
  sections: z.array(z.enum(REPORT_OPTIONAL_SECTIONS)).max(REPORT_OPTIONAL_SECTIONS.length),
  evidenceDetail: z.enum(REPORT_EVIDENCE_DETAILS),
  coverTitle: text(200),
  coverKicker: text(100),
  organization: text(100),
  client: text(100),
  classification: noControl(z.string().trim().min(1).max(20)),
  headerText: text(100),
  footerText: text(100),
  isDefault: z.boolean(),
};
const createBody = z
  .object({
    name: fields.name,
    sections: fields.sections.default([]),
    evidenceDetail: fields.evidenceDetail.default('full'),
    coverTitle: fields.coverTitle.default(''),
    coverKicker: fields.coverKicker.default(''),
    organization: fields.organization.default(''),
    client: fields.client.default(''),
    classification: fields.classification.default('内部使用'),
    headerText: fields.headerText.default(''),
    footerText: fields.footerText.default(''),
    isDefault: fields.isDefault.default(false),
  })
  .strict();
const updateBody = z.object(fields).partial().strict();

type TemplateRow = Prisma.ReportTemplateGetPayload<object>;

function serialize(t: TemplateRow) {
  return {
    id: t.id,
    name: t.name,
    sections: t.sections,
    evidenceDetail: t.evidenceDetail,
    coverTitle: t.coverTitle,
    coverKicker: t.coverKicker,
    organization: t.organization,
    client: t.client,
    classification: t.classification,
    headerText: t.headerText,
    footerText: t.footerText,
    isDefault: t.isDefault,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw conflict('同名报告模板已存在', 'REPORT_TEMPLATE_NAME_TAKEN');
  }
  throw err;
}

/** 设为默认：同一事务里先清本租户其他默认（部分唯一索引兜底）。 */
async function setDefault(id: string): Promise<TemplateRow> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.reportTemplate.findUnique({ where: { id } });
    if (!row) throw notFound('报告模板不存在', 'REPORT_TEMPLATE_NOT_FOUND');
    await tx.reportTemplate.updateMany({
      where: { tenantId: row.tenantId, isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
    return tx.reportTemplate.update({ where: { id }, data: { isDefault: true } });
  });
}

export async function reportTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  const audit = (req: FastifyRequest, action: string, id: string, detail?: unknown) => {
    const ua = req.headers['user-agent'];
    return writeAudit({
      actorId: req.currentUser!.id,
      actorName: req.currentUser!.username,
      action,
      targetType: 'report_template',
      targetId: id,
      ip: req.ip,
      userAgent: typeof ua === 'string' ? ua : null,
      detail,
    });
  };

  // 全部租户视角下带 ?tenantId= 只列该租户的（下载某个租户的报告时选模板用）。
  app.get('/', READ, async (req) => {
    const rows = await prisma.reportTemplate.findMany({
      where: tenantFilterWhere(req),
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return { items: rows.map(serialize) };
  });

  app.post('/', MANAGE, async (req, reply) => {
    const { isDefault, ...body } = createBody.parse(req.body ?? {});
    let row = await prisma.reportTemplate
      .create({ data: { ...body, createdById: req.currentUser!.id } })
      .catch(nameTaken);
    if (isDefault) row = await setDefault(row.id);
    await audit(req, 'report_template.create', row.id, { name: row.name, isDefault });
    reply.code(201);
    return serialize(row);
  });

  app.patch('/:id', MANAGE, async (req) => {
    const { id } = idParams.parse(req.params);
    const { isDefault, ...body } = updateBody.parse(req.body ?? {});
    const existing = await prisma.reportTemplate.findUnique({ where: { id } });
    if (!existing) throw notFound('报告模板不存在', 'REPORT_TEMPLATE_NOT_FOUND');
    let row = await prisma.reportTemplate
      .update({ where: { id }, data: { ...body, ...(isDefault === false ? { isDefault } : {}) } })
      .catch(nameTaken);
    if (isDefault) row = await setDefault(id);
    await audit(req, 'report_template.update', id, {
      changed: Object.keys(req.body ?? {}),
    });
    return serialize(row);
  });

  app.delete('/:id', MANAGE, async (req) => {
    const { id } = idParams.parse(req.params);
    const existing = await prisma.reportTemplate.findUnique({ where: { id } });
    if (!existing) throw notFound('报告模板不存在', 'REPORT_TEMPLATE_NOT_FOUND');
    await prisma.reportTemplate.delete({ where: { id } });
    await audit(req, 'report_template.delete', id, { name: existing.name });
    return { id, deleted: true };
  });

  app.post('/:id/default', MANAGE, async (req) => {
    const { id } = idParams.parse(req.params);
    const row = await setDefault(id);
    await audit(req, 'report_template.set_default', id, { name: row.name });
    return serialize(row);
  });
}
