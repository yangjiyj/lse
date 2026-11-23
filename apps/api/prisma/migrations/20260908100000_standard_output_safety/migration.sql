-- GB/T 45654-2025 输出安全专项：版本化题目、冻结发布版、样本尝试、判定和报告。
-- 仅新增表及索引，不改写历史题库/评估数据。
CREATE TABLE "standard_question_revisions" (
    "id" TEXT NOT NULL,
    "questionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT NOT NULL,
    "expectedBehavior" TEXT,
    "category" TEXT,
    "primaryCategory" TEXT,
    "secondaryCategories" TEXT[] NOT NULL,
    "nonRefusalTopic" TEXT,
    "language" TEXT NOT NULL DEFAULT 'zh',
    "modality" TEXT NOT NULL DEFAULT 'text',
    "purpose" TEXT,
    "source" TEXT,
    "standardProfileId" TEXT NOT NULL,
    "standardProfileVersion" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "standard_question_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "standard_question_reviews" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "correctionRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "standard_question_reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "standard_bank_releases" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "profileVersion" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'zh',
    "modalities" TEXT[] NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "counts" JSONB,
    "validation" JSONB,
    "overallHash" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "standard_bank_releases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "standard_bank_release_items" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "bankType" TEXT NOT NULL,
    "primaryCategory" TEXT,
    "nonRefusalTopic" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "standard_bank_release_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "standard_runs" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "bankReleaseId" TEXT NOT NULL,
    "previousTaskId" TEXT,
    "profileSnapshot" JSONB NOT NULL,
    "modelSnapshot" JSONB NOT NULL,
    "boundary" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "samplePlan" JSONB NOT NULL,
    "samplePlanHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceCompleteness" TEXT NOT NULL DEFAULT 'MISSING',
    "conclusion" TEXT NOT NULL DEFAULT 'INSUFFICIENT_EVIDENCE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "standard_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "standard_samples" (
    "id" TEXT NOT NULL,
    "standardRunId" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "revisionId" TEXT NOT NULL,
    "releaseItemId" TEXT NOT NULL,
    "inputSnapshot" TEXT NOT NULL,
    "expectedBehavior" TEXT,
    "primaryCategory" TEXT,
    "nonRefusalTopic" TEXT,
    "responseStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "selectedAttemptNo" INTEGER,
    "selectedResponse" TEXT,
    "selectedRawResponse" JSONB,
    "selectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "standard_samples_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "standard_sample_attempts" (
    "id" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "response" TEXT,
    "rawResponse" JSONB,
    "latencyMs" INTEGER,
    "httpStatus" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "standard_sample_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "standard_judgments" (
    "id" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "safetyOutcome" TEXT,
    "refusalOutcome" TEXT,
    "qualityOutcome" TEXT,
    "reason" TEXT,
    "evidence" TEXT,
    "judgedById" TEXT,
    "previousId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "standard_judgments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "standard_reports" (
    "id" TEXT NOT NULL,
    "standardRunId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "conclusion" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "generatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "standard_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "standard_question_revisions_questionId_version_key" ON "standard_question_revisions"("questionId", "version");
CREATE INDEX "standard_question_revisions_standardProfileId_language_modality_idx" ON "standard_question_revisions"("standardProfileId", "language", "modality");
CREATE INDEX "standard_question_revisions_contentHash_idx" ON "standard_question_revisions"("contentHash");
CREATE INDEX "standard_question_reviews_revisionId_createdAt_idx" ON "standard_question_reviews"("revisionId", "createdAt");
CREATE INDEX "standard_bank_releases_profileId_status_idx" ON "standard_bank_releases"("profileId", "status");
CREATE UNIQUE INDEX "standard_bank_release_items_releaseId_revisionId_key" ON "standard_bank_release_items"("releaseId", "revisionId");
CREATE UNIQUE INDEX "standard_bank_release_items_releaseId_bankType_position_key" ON "standard_bank_release_items"("releaseId", "bankType", "position");
CREATE INDEX "standard_bank_release_items_releaseId_bankType_idx" ON "standard_bank_release_items"("releaseId", "bankType");
CREATE UNIQUE INDEX "standard_runs_taskId_key" ON "standard_runs"("taskId");
CREATE INDEX "standard_runs_bankReleaseId_createdAt_idx" ON "standard_runs"("bankReleaseId", "createdAt");
CREATE INDEX "standard_runs_previousTaskId_idx" ON "standard_runs"("previousTaskId");
CREATE INDEX "standard_runs_status_evidenceCompleteness_idx" ON "standard_runs"("status", "evidenceCompleteness");
CREATE UNIQUE INDEX "standard_samples_standardRunId_group_sequence_key" ON "standard_samples"("standardRunId", "group", "sequence");
CREATE INDEX "standard_samples_standardRunId_group_responseStatus_idx" ON "standard_samples"("standardRunId", "group", "responseStatus");
CREATE UNIQUE INDEX "standard_sample_attempts_sampleId_attemptNo_key" ON "standard_sample_attempts"("sampleId", "attemptNo");
CREATE INDEX "standard_sample_attempts_sampleId_status_idx" ON "standard_sample_attempts"("sampleId", "status");
CREATE INDEX "standard_judgments_sampleId_source_createdAt_idx" ON "standard_judgments"("sampleId", "source", "createdAt");
CREATE UNIQUE INDEX "standard_reports_standardRunId_version_key" ON "standard_reports"("standardRunId", "version");
CREATE INDEX "standard_reports_standardRunId_createdAt_idx" ON "standard_reports"("standardRunId", "createdAt");

ALTER TABLE "standard_question_revisions" ADD CONSTRAINT "standard_question_revisions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "standard_question_revisions" ADD CONSTRAINT "standard_question_revisions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "standard_question_reviews" ADD CONSTRAINT "standard_question_reviews_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "standard_question_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standard_question_reviews" ADD CONSTRAINT "standard_question_reviews_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standard_bank_releases" ADD CONSTRAINT "standard_bank_releases_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "standard_bank_release_items" ADD CONSTRAINT "standard_bank_release_items_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "standard_bank_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standard_bank_release_items" ADD CONSTRAINT "standard_bank_release_items_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "standard_question_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standard_runs" ADD CONSTRAINT "standard_runs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "eval_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standard_runs" ADD CONSTRAINT "standard_runs_bankReleaseId_fkey" FOREIGN KEY ("bankReleaseId") REFERENCES "standard_bank_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standard_runs" ADD CONSTRAINT "standard_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "standard_samples" ADD CONSTRAINT "standard_samples_standardRunId_fkey" FOREIGN KEY ("standardRunId") REFERENCES "standard_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standard_samples" ADD CONSTRAINT "standard_samples_releaseItemId_fkey" FOREIGN KEY ("releaseItemId") REFERENCES "standard_bank_release_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standard_sample_attempts" ADD CONSTRAINT "standard_sample_attempts_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "standard_samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standard_judgments" ADD CONSTRAINT "standard_judgments_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "standard_samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standard_judgments" ADD CONSTRAINT "standard_judgments_judgedById_fkey" FOREIGN KEY ("judgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "standard_judgments" ADD CONSTRAINT "standard_judgments_previousId_fkey" FOREIGN KEY ("previousId") REFERENCES "standard_judgments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "standard_reports" ADD CONSTRAINT "standard_reports_standardRunId_fkey" FOREIGN KEY ("standardRunId") REFERENCES "standard_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standard_reports" ADD CONSTRAINT "standard_reports_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 权限显式分离：旧 operator 不因 question/eval 前缀自动获得标准题库发布或人工判定权限。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('standard_eval:read'), 'standard_eval:read', '查看标准专项', '标准专项'),
  (md5('standard_eval:run'), 'standard_eval:run', '发起标准专项', '标准专项'),
  (md5('standard_bank:edit'), 'standard_bank:edit', '维护标准题目版本', '标准专项'),
  (md5('standard_bank:review'), 'standard_bank:review', '审核标准题目版本', '标准专项'),
  (md5('standard_bank:publish'), 'standard_bank:publish', '发布标准题库版本', '标准专项'),
  (md5('standard_review:judge'), 'standard_review:judge', '提交标准人工判定', '标准专项'),
  (md5('standard_report:generate'), 'standard_report:generate', '生成标准对标报告', '标准专项')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" LIKE 'standard_%'
WHERE role."name" = 'admin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
