CREATE TABLE "finding_framework_mappings" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "framework" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "entryName" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'UPSERT',
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_framework_mappings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "finding_framework_mappings_findingId_idx" ON "finding_framework_mappings"("findingId");
CREATE INDEX "finding_framework_mappings_framework_entryId_idx" ON "finding_framework_mappings"("framework", "entryId");
CREATE UNIQUE INDEX "finding_framework_mappings_findingId_framework_entryId_key" ON "finding_framework_mappings"("findingId", "framework", "entryId");

ALTER TABLE "finding_framework_mappings" ADD CONSTRAINT "finding_framework_mappings_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "finding_framework_mappings" ADD CONSTRAINT "finding_framework_mappings_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
