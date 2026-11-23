CREATE TABLE "external_asset_assessments" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "sourceRequestId" TEXT NOT NULL UNIQUE,
 "sourceTenantId" TEXT NOT NULL,
 "sourceAssetId" TEXT NOT NULL,
 "sourceInstanceId" TEXT NOT NULL,
 "assetType" TEXT NOT NULL,
 "contentHash" TEXT NOT NULL,
 "rulesetVersion" TEXT NOT NULL,
 "coverage" TEXT NOT NULL,
 "verdict" TEXT NOT NULL,
 "findings" JSONB NOT NULL,
 "report" JSONB NOT NULL,
 "createdById" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "external_asset_assessments_sourceTenantId_sourceAssetId_createdAt_idx"
 ON "external_asset_assessments"("sourceTenantId","sourceAssetId","createdAt");
