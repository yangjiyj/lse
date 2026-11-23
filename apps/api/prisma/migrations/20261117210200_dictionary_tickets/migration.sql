-- 鉴盾对标一期 W6：数据字典（2.9.4）、技术支持与意见反馈工单（2.9.11、2.9.12）。

-- ── 数据字典：平台级、不分租户 ──
CREATE TABLE "dict_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dict_types_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dict_items" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dict_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dict_types_code_key" ON "dict_types"("code");
CREATE INDEX "dict_items_typeId_sort_idx" ON "dict_items"("typeId", "sort");
CREATE UNIQUE INDEX "dict_items_typeId_value_key" ON "dict_items"("typeId", "value");
ALTER TABLE "dict_items" ADD CONSTRAINT "dict_items_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "dict_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 内置「风险等级」：与 packages/shared/src/risk-level.ts 的 RISK_LEVEL_LABELS 一致。
-- id 用 md5 转成 uuid 格式，与 schema 的 @default(uuid()) 和接口的 uuid 校验一致。
INSERT INTO "dict_types" ("id", "code", "name", "description", "builtin", "createdAt", "updatedAt") VALUES
  (md5('dict_type:risk_level')::uuid::text, 'risk_level', '风险等级', NULL, true, now(), now())
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "dict_items" ("id", "typeId", "value", "label", "sort", "enabled", "createdAt", "updatedAt")
SELECT md5('dict_item:risk_level:' || v.value)::uuid::text, t."id", v.value, v.label, v.sort, true, now(), now()
FROM "dict_types" t
CROSS JOIN (VALUES ('HIGH', '高风险', 1), ('MEDIUM', '中风险', 2), ('LOW', '低风险', 3)) AS v(value, label, sort)
WHERE t."code" = 'risk_level'
ON CONFLICT ("typeId", "value") DO NOTHING;

-- ── 工单：按提交人所在租户归属 ──
CREATE TYPE "SupportTicketKind" AS ENUM ('SUPPORT', 'FEEDBACK');
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'REPLIED', 'CLOSED');

CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "kind" "SupportTicketKind" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_ticket_replies" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_replies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_tickets_tenantId_idx" ON "support_tickets"("tenantId");
CREATE INDEX "support_tickets_createdById_idx" ON "support_tickets"("createdById");
CREATE INDEX "support_tickets_kind_status_updatedAt_idx" ON "support_tickets"("kind", "status", "updatedAt");
CREATE INDEX "support_ticket_replies_ticketId_createdAt_idx" ON "support_ticket_replies"("ticketId", "createdAt");

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_ticket_replies" ADD CONSTRAINT "support_ticket_replies_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_ticket_replies" ADD CONSTRAINT "support_ticket_replies_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 没带租户写入时跟随提交人；推不出来归平台租户（与 multi_tenant 迁移的写法一致）。
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "support_tickets" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');

-- 工单处理权限：平台级，只给内置 admin。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('support:manage'), 'support:manage', '处理技术支持与意见反馈', '系统管理')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'support:manage'
WHERE role."name" = 'admin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
