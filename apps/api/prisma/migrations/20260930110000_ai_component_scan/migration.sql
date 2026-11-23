-- CreateTable
CREATE TABLE "ai_component_scans" (
    "id" TEXT NOT NULL,
    "assetName" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "assetVersion" TEXT,
    "assetKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceLabel" TEXT,
    "contentSha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "error" TEXT,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "highCount" INTEGER NOT NULL DEFAULT 0,
    "mediumCount" INTEGER NOT NULL DEFAULT 0,
    "lowCount" INTEGER NOT NULL DEFAULT 0,
    "files" JSONB,
    "snapshot" JSONB,
    "judgeStatus" TEXT,
    "linkedTaskId" TEXT,
    "linkedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_component_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_component_findings" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "riskCategory" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "remediation" TEXT NOT NULL,
    "filePath" TEXT,
    "line" INTEGER,
    "locations" JSONB,
    "evidence" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "detail" JSONB,
    "linkedFindingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_component_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_component_tool_baselines" (
    "id" TEXT NOT NULL,
    "assetKey" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "descriptionHash" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "firstScanId" TEXT NOT NULL,
    "lastScanId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_component_tool_baselines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_component_scans_assetKey_createdAt_idx" ON "ai_component_scans"("assetKey", "createdAt");

-- CreateIndex
CREATE INDEX "ai_component_scans_createdAt_idx" ON "ai_component_scans"("createdAt");

-- CreateIndex
CREATE INDEX "ai_component_findings_scanId_severity_idx" ON "ai_component_findings"("scanId", "severity");

-- CreateIndex
CREATE INDEX "ai_component_tool_baselines_toolName_idx" ON "ai_component_tool_baselines"("toolName");

-- CreateIndex
CREATE UNIQUE INDEX "ai_component_tool_baselines_assetKey_toolName_key" ON "ai_component_tool_baselines"("assetKey", "toolName");

-- AddForeignKey
ALTER TABLE "ai_component_findings" ADD CONSTRAINT "ai_component_findings_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "ai_component_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

