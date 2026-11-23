CREATE TABLE "filing_packages" (
  "id" TEXT NOT NULL, "runId" TEXT NOT NULL, "createdById" TEXT, "filename" TEXT NOT NULL, "sha256" TEXT NOT NULL, "archive" BYTEA NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "filing_packages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "filing_packages_runId_fkey" FOREIGN KEY ("runId") REFERENCES "standard_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "filing_packages_createdAt_idx" ON "filing_packages"("createdAt");
