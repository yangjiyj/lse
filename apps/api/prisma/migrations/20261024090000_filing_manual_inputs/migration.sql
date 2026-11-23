-- 备案底稿：人工抽检修订和可复用的单位信息。
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
