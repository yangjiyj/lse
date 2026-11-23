CREATE TYPE "ServiceAssuranceMode" AS ENUM ('SAFE', 'DEEP', 'SBOM');
CREATE TYPE "ServiceAssuranceTargetKind" AS ENUM ('ENDPOINT', 'OPENAPI', 'MCP', 'SBOM');
CREATE TYPE "ServiceAssuranceRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELED');
CREATE TYPE "ServiceAssuranceCoverageStatus" AS ENUM ('COMPLETE', 'INCOMPLETE', 'NOT_READY');
CREATE TYPE "AssuranceImpactStatus" AS ENUM ('UNDER_INVESTIGATION', 'AFFECTED', 'NOT_AFFECTED', 'FIXED');
CREATE TYPE "AssuranceEvidenceLevel" AS ENUM ('LEAD', 'VERSION_MATCH', 'CONFIG_MATCH', 'ACTIVE_VERIFIED');
CREATE TYPE "AssuranceEvidenceVisibility" AS ENUM ('CUSTOMER', 'TECHNICAL', 'AUDIT_ONLY');
CREATE TYPE "AssurancePriority" AS ENUM ('P0', 'P1', 'P2', 'P3', 'UNKNOWN');

CREATE TABLE "service_assurance_runs" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "createdById" TEXT,
  "mode" "ServiceAssuranceMode" NOT NULL,
  "targetKind" "ServiceAssuranceTargetKind" NOT NULL,
  "targetName" TEXT NOT NULL,
  "normalizedTarget" TEXT,
  "scopePolicyRef" TEXT NOT NULL,
  "credentialRef" TEXT,
  "authorizationConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "authorizationConfirmedAt" TIMESTAMP(3),
  "status" "ServiceAssuranceRunStatus" NOT NULL DEFAULT 'PENDING',
  "coverageStatus" "ServiceAssuranceCoverageStatus" NOT NULL DEFAULT 'NOT_READY',
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "requestBudget" JSONB NOT NULL,
  "rulesetVersion" TEXT,
  "rulesetDigest" TEXT,
  "vulnerabilityDbVersion" TEXT,
  "vulnerabilityDbDigest" TEXT,
  "engineVersions" JSONB,
  "startedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "retestOfRunId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_assurance_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_assets" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "customerName" TEXT NOT NULL,
  "normalizedAddress" TEXT NOT NULL,
  "protocol" TEXT,
  "host" TEXT,
  "port" INTEGER,
  "title" TEXT,
  "tlsSummary" JSONB,
  "assetKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_components" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "assetId" TEXT,
  "name" TEXT NOT NULL,
  "vendor" TEXT,
  "version" TEXT,
  "purl" TEXT,
  "cpe" TEXT,
  "hashes" JSONB,
  "source" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION,
  "evidenceLevel" "AssuranceEvidenceLevel" NOT NULL,
  "componentKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_components_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vulnerability_assessments" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "assetId" TEXT,
  "componentId" TEXT,
  "advisoryId" TEXT,
  "title" TEXT NOT NULL,
  "severity" "Severity",
  "cvss" DOUBLE PRECISION,
  "fixedVersion" TEXT,
  "kev" BOOLEAN,
  "epss" DOUBLE PRECISION,
  "impactStatus" "AssuranceImpactStatus" NOT NULL,
  "evidenceLevel" "AssuranceEvidenceLevel" NOT NULL,
  "confidence" DOUBLE PRECISION,
  "priority" "AssurancePriority" NOT NULL DEFAULT 'UNKNOWN',
  "reason" TEXT NOT NULL,
  "remediation" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "fixedByRunId" TEXT,
  "findingId" TEXT,
  "legacyFindingId" TEXT,
  "assessmentKey" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vulnerability_assessments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_evidence" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "assessmentId" TEXT,
  "componentId" TEXT,
  "evidenceType" TEXT NOT NULL,
  "sourceTool" TEXT NOT NULL,
  "ruleId" TEXT,
  "ruleSummary" TEXT,
  "matchedLocation" TEXT,
  "extractedValue" TEXT,
  "customerSummary" TEXT NOT NULL,
  "requestSummary" TEXT,
  "responseSummary" TEXT,
  "contentSha256" TEXT NOT NULL,
  "visibility" "AssuranceEvidenceVisibility" NOT NULL DEFAULT 'CUSTOMER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "service_assurance_runs_taskId_createdAt_idx" ON "service_assurance_runs"("taskId", "createdAt");
CREATE INDEX "service_assurance_runs_taskId_status_idx" ON "service_assurance_runs"("taskId", "status");
CREATE INDEX "service_assurance_runs_retestOfRunId_idx" ON "service_assurance_runs"("retestOfRunId");
CREATE UNIQUE INDEX "service_assets_runId_assetKey_key" ON "service_assets"("runId", "assetKey");
CREATE INDEX "service_assets_assetKey_idx" ON "service_assets"("assetKey");
CREATE UNIQUE INDEX "service_components_runId_componentKey_key" ON "service_components"("runId", "componentKey");
CREATE INDEX "service_components_assetId_idx" ON "service_components"("assetId");
CREATE INDEX "service_components_componentKey_idx" ON "service_components"("componentKey");
CREATE UNIQUE INDEX "vulnerability_assessments_findingId_key" ON "vulnerability_assessments"("findingId");
CREATE UNIQUE INDEX "vulnerability_assessments_runId_assessmentKey_key" ON "vulnerability_assessments"("runId", "assessmentKey");
CREATE INDEX "vulnerability_assessments_runId_impactStatus_idx" ON "vulnerability_assessments"("runId", "impactStatus");
CREATE INDEX "vulnerability_assessments_assetId_idx" ON "vulnerability_assessments"("assetId");
CREATE INDEX "vulnerability_assessments_componentId_idx" ON "vulnerability_assessments"("componentId");
CREATE INDEX "vulnerability_assessments_legacyFindingId_idx" ON "vulnerability_assessments"("legacyFindingId");
CREATE UNIQUE INDEX "service_evidence_runId_contentSha256_evidenceType_key" ON "service_evidence"("runId", "contentSha256", "evidenceType");
CREATE INDEX "service_evidence_assessmentId_idx" ON "service_evidence"("assessmentId");
CREATE INDEX "service_evidence_componentId_idx" ON "service_evidence"("componentId");

ALTER TABLE "service_assurance_runs" ADD CONSTRAINT "service_assurance_runs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "eval_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_assurance_runs" ADD CONSTRAINT "service_assurance_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_assurance_runs" ADD CONSTRAINT "service_assurance_runs_retestOfRunId_fkey" FOREIGN KEY ("retestOfRunId") REFERENCES "service_assurance_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_assets" ADD CONSTRAINT "service_assets_runId_fkey" FOREIGN KEY ("runId") REFERENCES "service_assurance_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_components" ADD CONSTRAINT "service_components_runId_fkey" FOREIGN KEY ("runId") REFERENCES "service_assurance_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_components" ADD CONSTRAINT "service_components_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "service_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vulnerability_assessments" ADD CONSTRAINT "vulnerability_assessments_runId_fkey" FOREIGN KEY ("runId") REFERENCES "service_assurance_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vulnerability_assessments" ADD CONSTRAINT "vulnerability_assessments_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "service_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vulnerability_assessments" ADD CONSTRAINT "vulnerability_assessments_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "service_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vulnerability_assessments" ADD CONSTRAINT "vulnerability_assessments_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vulnerability_assessments" ADD CONSTRAINT "vulnerability_assessments_fixedByRunId_fkey" FOREIGN KEY ("fixedByRunId") REFERENCES "service_assurance_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vulnerability_assessments" ADD CONSTRAINT "vulnerability_assessments_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vulnerability_assessments" ADD CONSTRAINT "vulnerability_assessments_legacyFindingId_fkey" FOREIGN KEY ("legacyFindingId") REFERENCES "findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_evidence" ADD CONSTRAINT "service_evidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "service_assurance_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_evidence" ADD CONSTRAINT "service_evidence_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "vulnerability_assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_evidence" ADD CONSTRAINT "service_evidence_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "service_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;
