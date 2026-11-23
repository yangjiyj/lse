-- 鉴盾对标二期第二批 B 线：报告模板（2.4.7）。章节取舍、封面、页眉页脚、密级、证据详略，租户内。

CREATE TABLE "report_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "sections" TEXT[],
    "evidenceDetail" TEXT NOT NULL DEFAULT 'full',
    "coverTitle" TEXT NOT NULL DEFAULT '',
    "coverKicker" TEXT NOT NULL DEFAULT '',
    "organization" TEXT NOT NULL DEFAULT '',
    "client" TEXT NOT NULL DEFAULT '',
    "classification" TEXT NOT NULL DEFAULT '内部使用',
    "headerText" TEXT NOT NULL DEFAULT '',
    "footerText" TEXT NOT NULL DEFAULT '',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "report_templates_tenantId_idx" ON "report_templates"("tenantId");
CREATE UNIQUE INDEX "report_templates_tenantId_name_key" ON "report_templates"("tenantId", "name");
-- 每个租户最多一个默认模板。
CREATE UNIQUE INDEX "report_templates_default_key" ON "report_templates"("tenantId") WHERE "isDefault";

-- 没带租户写入时跟随创建人；推不出来归平台租户。
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "report_templates" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');

-- 权限：管理报告模板给 admin、tenant_admin。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('report_template:manage'), 'report_template:manage', '管理报告模板', '报告')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'report_template:manage'
WHERE role."name" IN ('admin', 'tenant_admin')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
