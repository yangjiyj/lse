CREATE TABLE "agent_sample_trials" (
  "id" TEXT NOT NULL,
  "sampleId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "taskId" TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_sample_trials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_sample_trials_sampleId_version_fkey" FOREIGN KEY ("sampleId", "version") REFERENCES "agent_sample_versions"("sampleId", "version") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "agent_sample_trials_taskId_key" ON "agent_sample_trials"("taskId");
CREATE INDEX "agent_sample_trials_sampleId_version_createdAt_idx" ON "agent_sample_trials"("sampleId", "version", "createdAt");
