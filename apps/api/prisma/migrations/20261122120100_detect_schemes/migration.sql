-- 鉴盾对标二期第二批 C 线：检测方案（2.8.2）。需求配置 + 方案清单，状态读时推算不存。
-- 两张表都按租户隔离（tenant-models.ts 的 TENANT_OWNED_MODELS）。

CREATE TABLE "detect_schemes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "requirement" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "detect_schemes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "detect_scheme_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "schemeId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "assetId" TEXT,
    "category" TEXT NOT NULL,
    "entryKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "jobKind" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "title" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "origin" TEXT NOT NULL DEFAULT 'generated',
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "detect_scheme_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "detect_schemes_tenantId_idx" ON "detect_schemes"("tenantId");
CREATE UNIQUE INDEX "detect_schemes_tenantId_name_key" ON "detect_schemes"("tenantId", "name");
CREATE INDEX "detect_scheme_items_schemeId_position_idx" ON "detect_scheme_items"("schemeId", "position");
CREATE INDEX "detect_scheme_items_assetId_idx" ON "detect_scheme_items"("assetId");
CREATE INDEX "detect_scheme_items_tenantId_idx" ON "detect_scheme_items"("tenantId");

ALTER TABLE "detect_scheme_items" ADD CONSTRAINT "detect_scheme_items_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "detect_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- 删除台账资产时清单项保留，资产置空。
ALTER TABLE "detect_scheme_items" ADD CONSTRAINT "detect_scheme_items_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "ledger_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 没带租户写入时：方案跟随创建人，清单项跟随方案；推不出来归平台租户。
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "detect_schemes" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "detect_scheme_items" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('detect_schemes:schemeId', '@default');
-- 清单项引用的资产、所属方案都必须是同一租户的（每列一个触发器）。
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "assetId" ON "detect_scheme_items" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('ledger_assets:assetId');
CREATE TRIGGER "lse_tenant_21_guard" BEFORE INSERT OR UPDATE OF "tenantId", "schemeId" ON "detect_scheme_items" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('detect_schemes:schemeId');

-- 权限：与 packages/shared/src/permissions.ts 的 ROLE_DEFS 一致。
-- scheme:read 给全部内置角色；scheme:manage 给 admin、tenant_admin、operator（租户内权限，不是平台级）。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('scheme:read'), 'scheme:read', '查看检测方案', '检测方案'),
  (md5('scheme:manage'), 'scheme:manage', '维护检测方案', '检测方案')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" IN ('scheme:read', 'scheme:manage')
WHERE role."name" IN ('admin', 'tenant_admin', 'operator')
   OR (role."name" = 'auditor' AND permission."code" = 'scheme:read')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
