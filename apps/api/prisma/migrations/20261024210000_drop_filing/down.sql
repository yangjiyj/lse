-- 回滚：恢复五张表的结构（数据需从部署前导出的 SQL 另行导入）。
CREATE TABLE "keyword_libraries" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '客户关键词库',
  "version" TEXT NOT NULL DEFAULT '1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "keyword_libraries_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "keywords" (
  "id" TEXT NOT NULL,
  "libraryId" TEXT NOT NULL,
  "category" TEXT,
  "word" TEXT NOT NULL,
  "source" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" TEXT NOT NULL DEFAULT '1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "keywords_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "keywords_libraryId_category_word_key" ON "keywords"("libraryId", "category", "word");
CREATE INDEX "keywords_libraryId_category_enabled_idx" ON "keywords"("libraryId", "category", "enabled");
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "keyword_libraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "filing_packages" (
  "id" TEXT NOT NULL, "runId" TEXT NOT NULL, "createdById" TEXT, "filename" TEXT NOT NULL, "sha256" TEXT NOT NULL, "archive" BYTEA NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "filing_packages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "filing_packages_runId_fkey" FOREIGN KEY ("runId") REFERENCES "standard_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "filing_packages_createdAt_idx" ON "filing_packages"("createdAt");
CREATE TABLE "filing_compliance_overrides" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "clauseId" TEXT NOT NULL,
  "conclusion" TEXT NOT NULL,
  "autoConclusion" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "overriddenById" TEXT,
  "overriddenByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "filing_compliance_overrides_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "filing_compliance_overrides_runId_clauseId_createdAt_idx" ON "filing_compliance_overrides"("runId", "clauseId", "createdAt");
ALTER TABLE "filing_compliance_overrides" ADD CONSTRAINT "filing_compliance_overrides_runId_fkey" FOREIGN KEY ("runId") REFERENCES "standard_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "filing_packages" ADD COLUMN "size" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "filing_packages" ADD COLUMN "unmet" JSONB;
ALTER TABLE "filing_packages" ADD COLUMN "manifest" JSONB;
CREATE TABLE "filing_manual_sampling" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "revision" SERIAL NOT NULL UNIQUE,
  "runId" TEXT NOT NULL REFERENCES "standard_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('manual', 'keyword', 'classifier')),
  "sampled" INTEGER NOT NULL CHECK ("sampled" > 0),
  "qualified" INTEGER NOT NULL CHECK ("qualified" >= 0 AND "qualified" <= "sampled"),
  "inspector" TEXT NOT NULL,
  "sampledOn" TEXT NOT NULL,
  "notes" TEXT NOT NULL,
  "attachment" JSONB,
  "recordedById" TEXT,
  "recordedByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "filing_manual_sampling_runId_kind_revision_idx" ON "filing_manual_sampling"("runId", "kind", "revision");
CREATE TABLE "filing_organizations" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
  "organization" TEXT NOT NULL,
  "platformName" TEXT NOT NULL,
  "reportNo" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "basis" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "updatedById" TEXT,
  "updatedByName" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
