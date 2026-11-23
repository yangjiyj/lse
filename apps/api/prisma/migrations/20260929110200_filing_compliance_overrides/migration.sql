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
