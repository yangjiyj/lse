-- 多租户隔离补齐：让审计发现的跨租户缺口在数据库层也有兜底。
-- 1) gate_evaluations 的「门禁 × 任务」两端必须同租户；
-- 2) ai_component_tool_baselines、test_domains 加租户列与唯一键；
-- 3) standard_bank_releases 记录自动样本集的所属租户（平台发布的为空）；
-- 4) 外部资产来源请求号、策略建议生成幂等键改为租户内唯一。

-- ── 加列 ──
ALTER TABLE "ai_component_tool_baselines" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "test_domains" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "standard_bank_releases" ADD COLUMN "tenantId" TEXT;

-- ── 存量归属 ──
-- 工具基线的租户跟随首次发现它的扫描记录；推不出来时归平台租户。
UPDATE "ai_component_tool_baselines" SET "tenantId" = (
    SELECT s."tenantId" FROM "ai_component_scans" s WHERE s."id" = "ai_component_tool_baselines"."firstScanId"
);
UPDATE "ai_component_tool_baselines" SET "tenantId" = '00000000-0000-4000-8000-000000000001' WHERE "tenantId" IS NULL;
-- 历史测试领域都由平台租户的用户建立，归平台租户（新建的按创建人租户落库）。
UPDATE "test_domains" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
-- standard_bank_releases 保持为空：历史发布版都是平台标准题集，各租户可用。

-- ── 唯一键改为租户内唯一 ──
DROP INDEX "ai_component_tool_baselines_assetKey_toolName_key";
CREATE UNIQUE INDEX "ai_component_tool_baselines_tenantId_assetKey_toolName_key" ON "ai_component_tool_baselines"("tenantId", "assetKey", "toolName");
CREATE INDEX "ai_component_tool_baselines_tenantId_idx" ON "ai_component_tool_baselines"("tenantId");

DROP INDEX "test_domains_name_key";
CREATE UNIQUE INDEX "test_domains_tenantId_name_key" ON "test_domains"("tenantId", "name");
CREATE INDEX "test_domains_tenantId_idx" ON "test_domains"("tenantId");

-- 这一条原本是 UNIQUE 约束（不是普通索引），先按约束删，失败再按索引删。
ALTER TABLE "external_asset_assessments" DROP CONSTRAINT IF EXISTS "external_asset_assessments_sourceRequestId_key";
DROP INDEX IF EXISTS "external_asset_assessments_sourceRequestId_key";
CREATE UNIQUE INDEX "external_asset_assessments_tenantId_sourceRequestId_key" ON "external_asset_assessments"("tenantId", "sourceRequestId");

DROP INDEX "policy_suggestions_scopeKey_groupKey_key";
CREATE UNIQUE INDEX "policy_suggestions_tenantId_scopeKey_groupKey_key" ON "policy_suggestions"("tenantId", "scopeKey", "groupKey");

CREATE INDEX "standard_bank_releases_tenantId_idx" ON "standard_bank_releases"("tenantId");

-- ── 触发器：新行租户继承与跨租户引用拦截 ──
-- 工具基线的租户跟随首次扫描；推不出来归平台租户。
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "ai_component_tool_baselines" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('ai_component_scans:firstScanId', '@default');
-- 测试领域的租户跟随创建人；推不出来归平台租户（平台内置领域可为空，由平台管理员显式写入）。
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "test_domains" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
-- 门禁判定不能让「B 的门禁」对上「A 的任务」：两端租户都非空且不同直接拒绝。
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "gateId", "taskId" ON "gate_evaluations" FOR EACH ROW EXECUTE FUNCTION lse_tenant_link_guard('gate_rules:gateId', 'eval_tasks:taskId');

-- ── 平台共享裁判模型：显式写入的 tenantId = NULL 不能被兜底填成平台租户 ──
-- 背景：评估对象创建接口对「平台管理员在平台租户里新建的 JUDGE 模型」显式写 tenantId = NULL
-- （设计上属于平台共享，各租户只读可用）。但原 lse_tenant_fill('users:createdById','@default')
-- 会把 NULL 当成「没带租户」而填成平台租户，导致租户侧看不到平台裁判模型、llm-judge 被静默关掉。
-- 这里给填充函数补一个 spec：判官模型且创建人在平台租户时保持 NULL（其余情况照旧继承/兜底）。
CREATE OR REPLACE FUNCTION lse_tenant_fill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  spec text;
  parent_table text;
  fk_col text;
  fk_val text;
  found_tenant text;
  row_json jsonb;
  i int;
BEGIN
  IF NEW."tenantId" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  row_json := to_jsonb(NEW);
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    IF spec = '@default' THEN
      NEW."tenantId" := '00000000-0000-4000-8000-000000000001';
      RETURN NEW;
    ELSIF spec = '@shared_platform_judge' THEN
      IF (row_json ->> 'targetType') = 'JUDGE' AND (row_json ->> 'createdById') IS NOT NULL THEN
        EXECUTE 'SELECT "tenantId" FROM users WHERE "id" = $1' INTO found_tenant USING row_json ->> 'createdById';
        IF found_tenant = '00000000-0000-4000-8000-000000000001' THEN
          RETURN NEW;
        END IF;
      END IF;
    ELSIF spec LIKE '@default_unless_true:%' THEN
      IF coalesce((row_json ->> split_part(spec, ':', 2))::boolean, false) THEN
        RETURN NEW;
      END IF;
      NEW."tenantId" := '00000000-0000-4000-8000-000000000001';
      RETURN NEW;
    ELSIF spec LIKE '@default_when_eq:%' THEN
      IF row_json ->> split_part(split_part(spec, ':', 2), '=', 1) = split_part(split_part(spec, ':', 2), '=', 2) THEN
        NEW."tenantId" := '00000000-0000-4000-8000-000000000001';
      END IF;
      RETURN NEW;
    END IF;
    parent_table := split_part(spec, ':', 1);
    fk_col := split_part(spec, ':', 2);
    fk_val := row_json ->> fk_col;
    IF fk_val IS NOT NULL THEN
      EXECUTE format('SELECT "tenantId" FROM %I WHERE "id" = $1', parent_table) INTO found_tenant USING fk_val;
      IF found_tenant IS NOT NULL THEN
        NEW."tenantId" := found_tenant;
        RETURN NEW;
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER "lse_tenant_10_fill" ON "model_targets";
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "model_targets" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('@shared_platform_judge', 'users:createdById', '@default');
