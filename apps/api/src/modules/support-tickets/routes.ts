import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { conflict, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { asSystem } from '../../lib/tenant-context.js';
import type { CurrentUser } from '../../lib/rbac.js';

// 2.9.11 技术支持、2.9.12 意见反馈。
// 任何登录用户都能提交工单，只看得到自己提交的；support:manage（平台级，只给 admin）看全部租户的工单，
// 能回复和关闭。管理员回复后状态为 REPLIED，提交人追加回复后回到 OPEN，关闭后不能再回复。
// 工单跟人走：一律记在提交人的本属租户，平台管理员代管其他租户或在「全部租户」视角下提交、查看也一样，
// 所以提交人自己的读写都跳出租户范围、只按提交人过滤。

export const SUPPORT_MANAGE_PERMISSION = 'support:manage';

const kindEnum = z.enum(['SUPPORT', 'FEEDBACK']);
const statusEnum = z.enum(['OPEN', 'REPLIED', 'CLOSED']);
const idParams = z.object({ id: z.string().uuid() });
const createBody = z.object({
  kind: kindEnum,
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(5000),
});
const replyBody = z.object({ content: z.string().trim().min(1).max(5000) });
const listQuery = z.object({
  kind: kindEnum.optional(),
  status: statusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const userSelect = { select: { id: true, username: true, displayName: true } } as const;
const listInclude = {
  createdBy: userSelect,
  _count: { select: { replies: true } },
} satisfies Prisma.SupportTicketInclude;
const detailInclude = {
  createdBy: userSelect,
  replies: { include: { author: userSelect }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.SupportTicketInclude;

type ListRow = Prisma.SupportTicketGetPayload<{ include: typeof listInclude }>;
type DetailRow = Prisma.SupportTicketGetPayload<{ include: typeof detailInclude }>;
type UserRef = { id: string; username: string; displayName: string } | null;

const userView = (u: UserRef) => (u ? { id: u.id, name: u.displayName || u.username } : null);

function baseView(t: ListRow | DetailRow) {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    status: t.status,
    createdBy: userView(t.createdBy),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

function detailView(t: DetailRow) {
  return {
    ...baseView(t),
    content: t.content,
    replies: t.replies.map((r) => ({
      id: r.id,
      content: r.content,
      author: userView(r.author),
      // 是否提交人自己追加的；否则是处理人的答复。
      byCreator: r.authorId !== null && r.authorId === t.createdById,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

const isManager = (user: CurrentUser) => user.permissions.has(SUPPORT_MANAGE_PERMISSION);

/**
 * 读一张工单：处理人跨租户读，其他人只能读自己提交的；读不到一律 404。
 * 都跳出租户范围：工单记在提交人的本属租户，代管其他租户时也要读得到自己的。
 */
async function loadTicket(user: CurrentUser, id: string): Promise<DetailRow> {
  const where = isManager(user) ? { id } : { id, createdById: user.id };
  const ticket = await asSystem(
    async () => await prisma.supportTicket.findFirst({ where, include: detailInclude }),
  );
  if (!ticket) throw notFound('工单不存在', 'SUPPORT_TICKET_NOT_FOUND');
  return ticket;
}

const closedConflict = () => conflict('工单已关闭，不能再回复', 'SUPPORT_TICKET_CLOSED');

function audit(
  request: FastifyRequest,
  action: string,
  ticketId: string,
  detail: Record<string, unknown>,
) {
  return writeAudit({
    actorId: request.currentUser!.id,
    actorName: request.currentUser!.username,
    action,
    targetType: 'support_ticket',
    targetId: ticketId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    detail,
  });
}

export async function supportTicketRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  const canManage = requirePermission(SUPPORT_MANAGE_PERMISSION);

  // 我的工单：只按提交人过滤，不按当前操作的租户过滤（代管、全部租户视角下也只列自己的）。
  app.get('/', async (request) => {
    const q = listQuery.parse(request.query);
    const where: Prisma.SupportTicketWhereInput = {
      createdById: request.currentUser!.id,
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [total, rows] = await asSystem(
      async () =>
        await Promise.all([
          prisma.supportTicket.count({ where }),
          prisma.supportTicket.findMany({
            where,
            include: listInclude,
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            skip: (q.page - 1) * q.pageSize,
            take: q.pageSize,
          }),
        ]),
    );
    return {
      items: rows.map((t) => ({ ...baseView(t), replyCount: t._count.replies })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  // 工单处理：全部租户。注册在 /:id 之前。
  app.get('/manage', { preHandler: canManage }, async (request) => {
    const q = listQuery.parse(request.query);
    const where: Prisma.SupportTicketWhereInput = {
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const { total, rows } = await asSystem(async () => {
      const [count, list] = await Promise.all([
        prisma.supportTicket.count({ where }),
        prisma.supportTicket.findMany({
          where,
          include: listInclude,
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
      ]);
      return { total: count, rows: list };
    });
    const tenantIds = [
      ...new Set(rows.map((t) => t.tenantId).filter((id): id is string => Boolean(id))),
    ];
    const tenants = tenantIds.length
      ? await prismaUnscoped.tenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, name: true },
        })
      : [];
    const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
    return {
      items: rows.map((t) => ({
        ...baseView(t),
        replyCount: t._count.replies,
        tenantName: t.tenantId ? (tenantName.get(t.tenantId) ?? null) : null,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  app.post('/', async (request, reply) => {
    const body = createBody.parse(request.body ?? {});
    const user = request.currentUser!;
    // 记在提交人的本属租户：平台管理员代管其他租户时提交，不能记到被代管的租户名下。
    const ticket = await asSystem(
      async () =>
        await prisma.supportTicket.create({
          data: {
            tenantId: user.homeTenantId,
            kind: body.kind,
            title: body.title,
            content: body.content,
            createdById: user.id,
          },
          include: detailInclude,
        }),
    );
    await audit(request, 'support_ticket.create', ticket.id, {
      kind: ticket.kind,
      title: ticket.title,
    });
    reply.code(201);
    return detailView(ticket);
  });

  app.get('/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    return detailView(await loadTicket(request.currentUser!, id));
  });

  app.post('/:id/replies', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { content } = replyBody.parse(request.body ?? {});
    const user = request.currentUser!;
    const ticket = await loadTicket(user, id);
    if (ticket.status === 'CLOSED') throw closedConflict();
    const byCreator = ticket.createdById === user.id;
    const status = byCreator ? 'OPEN' : 'REPLIED';
    // 访问权已在 loadTicket 校验过；处理人回复的是其他租户的工单，按 id 跨租户写。
    // 改状态时再判一次「未关闭」：读完到写之间工单可能刚被关闭，更新不到就整体回滚，不能把 CLOSED 改回去。
    const updated = await asSystem(
      async () =>
        await prisma.$transaction(async (tx) => {
          const { count } = await tx.supportTicket.updateMany({
            where: { id, status: { not: 'CLOSED' } },
            data: { status },
          });
          if (count === 0) throw closedConflict();
          await tx.supportTicketReply.create({
            data: { ticketId: id, authorId: user.id, content },
          });
          return await tx.supportTicket.findUniqueOrThrow({
            where: { id },
            include: detailInclude,
          });
        }),
    );
    await audit(request, 'support_ticket.reply', id, { status, byCreator });
    reply.code(201);
    return detailView(updated);
  });

  app.post('/:id/close', { preHandler: canManage }, async (request) => {
    const { id } = idParams.parse(request.params);
    const ticket = await loadTicket(request.currentUser!, id);
    if (ticket.status === 'CLOSED') throw conflict('工单已关闭', 'SUPPORT_TICKET_CLOSED');
    const updated = await asSystem(
      async () =>
        await prisma.supportTicket.update({
          where: { id },
          data: { status: 'CLOSED' },
          include: detailInclude,
        }),
    );
    await audit(request, 'support_ticket.close', id, { kind: ticket.kind, title: ticket.title });
    return detailView(updated);
  });
}
