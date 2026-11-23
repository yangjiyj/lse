-- 鉴盾对标二期第二批 C 线：应用台账（2.8.1）。
-- 资产与关系都按租户隔离（tenant-models.ts 的 TENANT_OWNED_MODELS）；终端关联 fleet_endpoints，模型关联 model_targets，
-- 组织关联 organizations。评估对象可以是平台共享的（tenantId 为空），guard 不管它，由接口校验「本租户或平台共享」。

CREATE TABLE "ledger_assets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "ownerName" TEXT,
    "ownerDepartment" TEXT,
    "organizationId" TEXT,
    "tags" TEXT[],
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "fleetEndpointId" TEXT,
    "modelTargetId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ledger_relations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_relations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ledger_assets_fleetEndpointId_key" ON "ledger_assets"("fleetEndpointId");
CREATE INDEX "ledger_assets_tenantId_idx" ON "ledger_assets"("tenantId");
CREATE INDEX "ledger_assets_modelTargetId_idx" ON "ledger_assets"("modelTargetId");
CREATE INDEX "ledger_assets_organizationId_idx" ON "ledger_assets"("organizationId");
CREATE UNIQUE INDEX "ledger_assets_tenantId_type_name_key" ON "ledger_assets"("tenantId", "type", "name");
CREATE UNIQUE INDEX "ledger_assets_tenantId_code_key" ON "ledger_assets"("tenantId", "code");
CREATE UNIQUE INDEX "ledger_assets_tenantId_type_modelTargetId_key" ON "ledger_assets"("tenantId", "type", "modelTargetId");
CREATE INDEX "ledger_relations_toId_idx" ON "ledger_relations"("toId");
CREATE INDEX "ledger_relations_tenantId_idx" ON "ledger_relations"("tenantId");
CREATE UNIQUE INDEX "ledger_relations_fromId_toId_kind_key" ON "ledger_relations"("fromId", "toId", "kind");

ALTER TABLE "ledger_assets" ADD CONSTRAINT "ledger_assets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ledger_assets" ADD CONSTRAINT "ledger_assets_fleetEndpointId_fkey" FOREIGN KEY ("fleetEndpointId") REFERENCES "fleet_endpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ledger_assets" ADD CONSTRAINT "ledger_assets_modelTargetId_fkey" FOREIGN KEY ("modelTargetId") REFERENCES "model_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ledger_relations" ADD CONSTRAINT "ledger_relations_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "ledger_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_relations" ADD CONSTRAINT "ledger_relations_toId_fkey" FOREIGN KEY ("toId") REFERENCES "ledger_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 没带租户写入时：资产跟随创建人，关系跟随源资产；推不出来归平台租户。
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "ledger_assets" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "ledger_relations" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('ledger_assets:fromId', '@default');
-- 关系两端、资产关联的终端和组织都必须是同一租户的（每列一个触发器）。
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "toId" ON "ledger_relations" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('ledger_assets:toId');
CREATE TRIGGER "lse_tenant_21_guard" BEFORE INSERT OR UPDATE OF "tenantId", "fromId" ON "ledger_relations" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('ledger_assets:fromId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "fleetEndpointId" ON "ledger_assets" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('fleet_endpoints:fleetEndpointId');
CREATE TRIGGER "lse_tenant_21_guard" BEFORE INSERT OR UPDATE OF "tenantId", "organizationId" ON "ledger_assets" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('organizations:organizationId');

-- 权限：与 packages/shared/src/permissions.ts 的 ROLE_DEFS 一致。
-- ledger:read 给全部内置角色；ledger:manage 给 admin、tenant_admin、operator（租户内权限，不是平台级）。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('ledger:read'), 'ledger:read', '查看应用台账', '应用台账'),
  (md5('ledger:manage'), 'ledger:manage', '维护应用台账', '应用台账')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" IN ('ledger:read', 'ledger:manage')
WHERE role."name" IN ('admin', 'tenant_admin', 'operator')
   OR (role."name" = 'auditor' AND permission."code" = 'ledger:read')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
