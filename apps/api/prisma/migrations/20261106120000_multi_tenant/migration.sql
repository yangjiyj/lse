-- 多租户：租户表、各业务表的 tenantId、存量数据归入默认租户、写入时自动继承租户的触发器、跨租户引用拦截。

CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPlatform" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenants_name_key" ON "tenants"("name");
CREATE UNIQUE INDEX "tenants_code_key" ON "tenants"("code");
INSERT INTO "tenants" ("id", "name", "code", "description", "isActive", "isPlatform", "createdAt", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000001', '默认租户', 'default', '平台租户：升级前的全部数据都在这里，平台管理员也在这里。', true, true, now(), now());

-- 用户
ALTER TABLE "users" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';
CREATE INDEX "users_tenantId_idx" ON "users"("tenantId");
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 业务表：加列 + 存量归属 + 索引
ALTER TABLE "model_targets" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "question_sets" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "questions" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "agent_samples" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "eval_tasks" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "eval_plans" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "batch_evaluations" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "reports" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "api_tokens" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "gate_rules" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "policy_suggestions" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "model_file_uploads" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "model_file_scans" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "model_file_findings" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "asset_discovery_runs" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "rag_corpora" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "rag_test_sets" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "rag_eval_runs" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "ai_component_scans" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "ai_component_findings" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "service_assurance_runs" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "vulnerability_assessments" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "fleet_enrollment_codes" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "fleet_endpoints" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "fleet_probe_reports" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "fleet_eval_jobs" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "external_asset_assessments" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "eval_results" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "findings" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "wrong_answers" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "model_fingerprints" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "standard_runs" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "agent_sample_trials" ADD COLUMN "tenantId" TEXT;

UPDATE "model_targets" SET "tenantId" = CASE WHEN "targetType" = 'JUDGE' THEN NULL ELSE '00000000-0000-4000-8000-000000000001' END;
UPDATE "question_sets" SET "tenantId" = CASE WHEN "isBuiltin" THEN NULL ELSE '00000000-0000-4000-8000-000000000001' END;
UPDATE "agent_samples" SET "tenantId" = CASE WHEN "source" = 'custom' THEN '00000000-0000-4000-8000-000000000001' ELSE NULL END;
UPDATE "eval_tasks" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "eval_plans" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "batch_evaluations" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "reports" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "api_tokens" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "gate_rules" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "policy_suggestions" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "model_file_uploads" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "model_file_scans" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "model_file_findings" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "asset_discovery_runs" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "rag_corpora" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "rag_test_sets" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "rag_eval_runs" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "ai_component_scans" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "ai_component_findings" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "service_assurance_runs" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "vulnerability_assessments" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "fleet_enrollment_codes" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "fleet_endpoints" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "fleet_probe_reports" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "fleet_eval_jobs" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "audit_logs" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "external_asset_assessments" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "eval_results" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "findings" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "wrong_answers" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "model_fingerprints" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "standard_runs" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "agent_sample_trials" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "questions" q SET "tenantId" = s."tenantId" FROM "question_sets" s WHERE s."id" = q."questionSetId";

CREATE INDEX "model_targets_tenantId_idx" ON "model_targets"("tenantId");
CREATE INDEX "question_sets_tenantId_idx" ON "question_sets"("tenantId");
CREATE INDEX "questions_tenantId_idx" ON "questions"("tenantId");
CREATE INDEX "agent_samples_tenantId_idx" ON "agent_samples"("tenantId");
CREATE INDEX "eval_tasks_tenantId_idx" ON "eval_tasks"("tenantId");
CREATE INDEX "eval_plans_tenantId_idx" ON "eval_plans"("tenantId");
CREATE INDEX "batch_evaluations_tenantId_idx" ON "batch_evaluations"("tenantId");
CREATE INDEX "reports_tenantId_idx" ON "reports"("tenantId");
CREATE INDEX "api_tokens_tenantId_idx" ON "api_tokens"("tenantId");
CREATE INDEX "gate_rules_tenantId_idx" ON "gate_rules"("tenantId");
CREATE INDEX "policy_suggestions_tenantId_idx" ON "policy_suggestions"("tenantId");
CREATE INDEX "model_file_uploads_tenantId_idx" ON "model_file_uploads"("tenantId");
CREATE INDEX "model_file_scans_tenantId_idx" ON "model_file_scans"("tenantId");
CREATE INDEX "model_file_findings_tenantId_idx" ON "model_file_findings"("tenantId");
CREATE INDEX "asset_discovery_runs_tenantId_idx" ON "asset_discovery_runs"("tenantId");
CREATE INDEX "rag_corpora_tenantId_idx" ON "rag_corpora"("tenantId");
CREATE INDEX "rag_test_sets_tenantId_idx" ON "rag_test_sets"("tenantId");
CREATE INDEX "rag_eval_runs_tenantId_idx" ON "rag_eval_runs"("tenantId");
CREATE INDEX "ai_component_scans_tenantId_idx" ON "ai_component_scans"("tenantId");
CREATE INDEX "ai_component_findings_tenantId_idx" ON "ai_component_findings"("tenantId");
CREATE INDEX "service_assurance_runs_tenantId_idx" ON "service_assurance_runs"("tenantId");
CREATE INDEX "vulnerability_assessments_tenantId_idx" ON "vulnerability_assessments"("tenantId");
CREATE INDEX "fleet_enrollment_codes_tenantId_idx" ON "fleet_enrollment_codes"("tenantId");
CREATE INDEX "fleet_endpoints_tenantId_idx" ON "fleet_endpoints"("tenantId");
CREATE INDEX "fleet_probe_reports_tenantId_idx" ON "fleet_probe_reports"("tenantId");
CREATE INDEX "fleet_eval_jobs_tenantId_idx" ON "fleet_eval_jobs"("tenantId");
CREATE INDEX "audit_logs_tenantId_idx" ON "audit_logs"("tenantId");
CREATE INDEX "external_asset_assessments_tenantId_idx" ON "external_asset_assessments"("tenantId");
CREATE INDEX "eval_results_tenantId_idx" ON "eval_results"("tenantId");
CREATE INDEX "findings_tenantId_idx" ON "findings"("tenantId");
CREATE INDEX "wrong_answers_tenantId_idx" ON "wrong_answers"("tenantId");
CREATE INDEX "model_fingerprints_tenantId_idx" ON "model_fingerprints"("tenantId");
CREATE INDEX "standard_runs_tenantId_idx" ON "standard_runs"("tenantId");
CREATE INDEX "agent_sample_trials_tenantId_idx" ON "agent_sample_trials"("tenantId");

-- 评估对象名称改为租户内唯一
DROP INDEX "model_targets_name_key";
CREATE UNIQUE INDEX "model_targets_tenantId_name_key" ON "model_targets"("tenantId", "name");

-- 写入时 tenantId 为空：按参数顺序从父对象继承租户；推不出来时按兜底规则处理
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

-- 跨租户引用拦截：本行租户与父对象租户都不为空且不同 → 拒绝（父对象为平台共享时放行）
CREATE OR REPLACE FUNCTION lse_tenant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  spec text;
  parent_table text;
  fk_col text;
  fk_val text;
  parent_tenant text;
  row_json jsonb;
  i int;
BEGIN
  IF NEW."tenantId" IS NULL THEN
    RETURN NEW;
  END IF;
  row_json := to_jsonb(NEW);
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    parent_table := split_part(spec, ':', 1);
    fk_col := split_part(spec, ':', 2);
    fk_val := row_json ->> fk_col;
    IF fk_val IS NOT NULL THEN
      EXECUTE format('SELECT "tenantId" FROM %I WHERE "id" = $1', parent_table) INTO parent_tenant USING fk_val;
      IF parent_tenant IS NOT NULL AND parent_tenant <> NEW."tenantId" THEN
        RAISE EXCEPTION 'LSE_CROSS_TENANT_REFERENCE %.% -> %', TG_TABLE_NAME, fk_col, parent_table USING ERRCODE = '42501';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- 关联表（无租户列）：两端租户都不为空且不同 → 拒绝
CREATE OR REPLACE FUNCTION lse_tenant_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_json jsonb;
  left_tenant text;
  right_tenant text;
  left_val text;
  right_val text;
BEGIN
  row_json := to_jsonb(NEW);
  left_val := row_json ->> split_part(TG_ARGV[0], ':', 2);
  right_val := row_json ->> split_part(TG_ARGV[1], ':', 2);
  IF left_val IS NULL OR right_val IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT "tenantId" FROM %I WHERE "id" = $1', split_part(TG_ARGV[0], ':', 1)) INTO left_tenant USING left_val;
  EXECUTE format('SELECT "tenantId" FROM %I WHERE "id" = $1', split_part(TG_ARGV[1], ':', 1)) INTO right_tenant USING right_val;
  IF left_tenant IS NOT NULL AND right_tenant IS NOT NULL AND left_tenant <> right_tenant THEN
    RAISE EXCEPTION 'LSE_CROSS_TENANT_REFERENCE %', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "model_targets" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "question_sets" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default_unless_true:isBuiltin');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "questions" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('question_sets:questionSetId');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "agent_samples" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('@default_when_eq:source=custom');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "eval_tasks" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_plans:planId', 'eval_tasks:parentTaskId', 'model_targets:modelTargetId', 'users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "eval_plans" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('model_targets:targetId', 'users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "batch_evaluations" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "reports" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_tasks:taskId', 'model_targets:evaluatedTargetId', 'users:generatedById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "api_tokens" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "gate_rules" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_plans:planId', 'model_targets:modelTargetId', 'users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "policy_suggestions" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_tasks:taskId', 'model_targets:modelTargetId', 'users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "model_file_uploads" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "model_file_scans" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('model_file_uploads:uploadId', 'model_targets:targetId', 'users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "model_file_findings" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('model_file_scans:scanId', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "asset_discovery_runs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "rag_corpora" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "rag_test_sets" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('rag_corpora:corpusId', 'users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "rag_eval_runs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_tasks:taskId', 'rag_test_sets:testSetId', 'model_targets:modelTargetId', 'users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "ai_component_scans" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_tasks:linkedTaskId', 'users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "ai_component_findings" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('ai_component_scans:scanId', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "service_assurance_runs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_tasks:taskId', 'service_assurance_runs:retestOfRunId', 'users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "vulnerability_assessments" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('service_assurance_runs:runId', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "fleet_enrollment_codes" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "fleet_endpoints" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('fleet_enrollment_codes:enrollmentCodeId', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "fleet_probe_reports" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('fleet_endpoints:endpointId', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "fleet_eval_jobs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('fleet_endpoints:endpointId', 'eval_tasks:evalTaskId', 'users:requestedById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:actorId', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "external_asset_assessments" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "eval_results" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_tasks:taskId', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "findings" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_tasks:taskId', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "wrong_answers" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_tasks:taskId', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "model_fingerprints" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('model_targets:modelTargetId', 'users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "standard_runs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_tasks:taskId', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "agent_sample_trials" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('eval_tasks:taskId', 'users:createdById', '@default');

CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "modelTargetId", "planId", "parentTaskId" ON "eval_tasks" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('model_targets:modelTargetId', 'eval_plans:planId', 'eval_tasks:parentTaskId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "targetId" ON "eval_plans" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('model_targets:targetId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "planId", "modelTargetId" ON "gate_rules" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('eval_plans:planId', 'model_targets:modelTargetId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "taskId" ON "reports" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('eval_tasks:taskId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "taskId", "modelTargetId" ON "policy_suggestions" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('eval_tasks:taskId', 'model_targets:modelTargetId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "uploadId", "targetId" ON "model_file_scans" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('model_file_uploads:uploadId', 'model_targets:targetId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "corpusId" ON "rag_test_sets" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('rag_corpora:corpusId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "taskId", "testSetId", "modelTargetId" ON "rag_eval_runs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('eval_tasks:taskId', 'rag_test_sets:testSetId', 'model_targets:modelTargetId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "taskId" ON "service_assurance_runs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('eval_tasks:taskId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "linkedTaskId" ON "ai_component_scans" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('eval_tasks:linkedTaskId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "endpointId", "evalTaskId" ON "fleet_eval_jobs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('fleet_endpoints:endpointId', 'eval_tasks:evalTaskId');

CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "taskId", "questionSetId" ON "eval_task_question_sets" FOR EACH ROW EXECUTE FUNCTION lse_tenant_link_guard('eval_tasks:taskId', 'question_sets:questionSetId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "taskId", "questionId" ON "eval_task_questions" FOR EACH ROW EXECUTE FUNCTION lse_tenant_link_guard('eval_tasks:taskId', 'questions:questionId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "planId", "targetId" ON "batch_evaluation_runs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_link_guard('batch_evaluations:planId', 'model_targets:targetId');
