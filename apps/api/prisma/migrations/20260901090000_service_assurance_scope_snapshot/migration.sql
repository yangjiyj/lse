ALTER TABLE "service_assurance_runs"
  ADD COLUMN "scopePolicySnapshot" JSONB,
  ADD COLUMN "scopePolicyDigest" TEXT;
