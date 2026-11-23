-- 鉴盾对标二期第二批 C 线：检测方案与组合任务关联、台账资产与子任务关联（2.8.4）。
-- B 线迁移 20261122110000 已建好 detect_jobs."schemeId"、detect_job_items."ledgerAssetId" 两列和索引，这里补外键和租户守卫。

-- 上线前若有指向不存在记录的值（理论上没有），先置空，外键才能建上。
UPDATE "detect_jobs" j SET "schemeId" = NULL
WHERE j."schemeId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "detect_schemes" s WHERE s."id" = j."schemeId");
UPDATE "detect_job_items" i SET "ledgerAssetId" = NULL
WHERE i."ledgerAssetId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ledger_assets" a WHERE a."id" = i."ledgerAssetId");

-- 删除方案、台账资产时组合任务和子任务保留，关联置空。
ALTER TABLE "detect_jobs" ADD CONSTRAINT "detect_jobs_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "detect_schemes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "detect_job_items" ADD CONSTRAINT "detect_job_items_ledgerAssetId_fkey" FOREIGN KEY ("ledgerAssetId") REFERENCES "ledger_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 组合任务关联的方案、子任务关联的台账资产都必须是同一租户的（detect_jobs 的 lse_tenant_20_guard 已被策略守卫占用）。
CREATE TRIGGER "lse_tenant_21_guard" BEFORE INSERT OR UPDATE OF "tenantId", "schemeId" ON "detect_jobs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('detect_schemes:schemeId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "ledgerAssetId" ON "detect_job_items" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('ledger_assets:ledgerAssetId');
