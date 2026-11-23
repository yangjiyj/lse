-- 鉴盾对标二期 G 线：语料扫描（数据安全工具，1.2.1、1.2.2、1.2.3、1.2.5）。
-- 四张表都按租户隔离（登记在 tenant-models.ts 的 TENANT_OWNED_MODELS），没带租户写入时按父表或创建人补齐。

CREATE TABLE "corpus_rule_sets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "corpus_rule_sets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "corpus_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "ruleSetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "corpus_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "corpus_scans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "maskedKey" TEXT,
    "filesPurgedAt" TIMESTAMP(3),
    "format" TEXT NOT NULL DEFAULT 'auto',
    "detectedFormat" TEXT,
    "container" TEXT,
    "csvColumns" JSONB,
    "ruleSetId" TEXT,
    "judgeReview" BOOLEAN NOT NULL DEFAULT false,
    "judgeLimit" INTEGER NOT NULL DEFAULT 200,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "progressBytes" BIGINT NOT NULL DEFAULT 0,
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "invalidRecords" INTEGER NOT NULL DEFAULT 0,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "storedFindings" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "stats" JSONB,
    "judgeReviewed" INTEGER NOT NULL DEFAULT 0,
    "judgeNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "corpus_scans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "corpus_findings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "scanId" TEXT NOT NULL,
    "recordIndex" INTEGER NOT NULL,
    "line" INTEGER NOT NULL,
    "fieldPath" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subtype" TEXT NOT NULL,
    "subtypeLabel" TEXT,
    "ruleId" TEXT,
    "matchText" TEXT NOT NULL,
    "contextBefore" TEXT NOT NULL DEFAULT '',
    "contextAfter" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL,
    "judgeVerdict" TEXT,
    "judgeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corpus_findings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "corpus_rule_sets_tenantId_name_key" ON "corpus_rule_sets"("tenantId", "name");
CREATE INDEX "corpus_rule_sets_tenantId_idx" ON "corpus_rule_sets"("tenantId");
CREATE UNIQUE INDEX "corpus_rules_ruleSetId_kind_pattern_key" ON "corpus_rules"("ruleSetId", "kind", "pattern");
CREATE INDEX "corpus_rules_tenantId_idx" ON "corpus_rules"("tenantId");
CREATE UNIQUE INDEX "corpus_scans_storageKey_key" ON "corpus_scans"("storageKey");
CREATE UNIQUE INDEX "corpus_scans_maskedKey_key" ON "corpus_scans"("maskedKey");
CREATE INDEX "corpus_scans_tenantId_idx" ON "corpus_scans"("tenantId");
CREATE INDEX "corpus_scans_createdAt_idx" ON "corpus_scans"("createdAt");
CREATE INDEX "corpus_findings_scanId_category_idx" ON "corpus_findings"("scanId", "category");
CREATE INDEX "corpus_findings_scanId_recordIndex_idx" ON "corpus_findings"("scanId", "recordIndex");
CREATE INDEX "corpus_findings_tenantId_idx" ON "corpus_findings"("tenantId");

ALTER TABLE "corpus_rules" ADD CONSTRAINT "corpus_rules_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "corpus_rule_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "corpus_scans" ADD CONSTRAINT "corpus_scans_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "corpus_rule_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "corpus_findings" ADD CONSTRAINT "corpus_findings_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "corpus_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 没带租户写入时：规则集、扫描跟随创建人，规则跟随规则集，命中跟随扫描（worker 写命中时没有租户上下文）；推不出来归平台租户。
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "corpus_rule_sets" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "corpus_rules" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('corpus_rule_sets:ruleSetId', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "corpus_scans" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "corpus_findings" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('corpus_scans:scanId', '@default');
-- 扫描引用的规则集必须是同一租户的。
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "ruleSetId" ON "corpus_scans" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('corpus_rule_sets:ruleSetId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "ruleSetId" ON "corpus_rules" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('corpus_rule_sets:ruleSetId');

-- 权限：查看、发起、导出（命中原文和打码副本）给 admin、tenant_admin、operator，查看另给 auditor；
-- 管理全部扫描（删除别人发起的）和规则管理给 admin、tenant_admin。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('corpus_scan:read'), 'corpus_scan:read', '查看语料扫描', '语料扫描'),
  (md5('corpus_scan:create'), 'corpus_scan:create', '发起语料扫描', '语料扫描'),
  (md5('corpus_scan:export'), 'corpus_scan:export', '导出语料扫描结果和打码副本', '语料扫描'),
  (md5('corpus_scan:manage'), 'corpus_scan:manage', '管理全部语料扫描', '语料扫描'),
  (md5('corpus_rule:manage'), 'corpus_rule:manage', '管理语料规则', '语料扫描')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" IN ('corpus_scan:read', 'corpus_scan:create', 'corpus_scan:export', 'corpus_scan:manage', 'corpus_rule:manage')
WHERE role."name" IN ('admin', 'tenant_admin')
   OR (role."name" = 'operator' AND permission."code" IN ('corpus_scan:read', 'corpus_scan:create', 'corpus_scan:export'))
   OR (role."name" = 'auditor' AND permission."code" = 'corpus_scan:read')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
