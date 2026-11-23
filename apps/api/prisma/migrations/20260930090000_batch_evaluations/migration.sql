-- CreateTable
CREATE TABLE "batch_evaluations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "EvalTaskStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'ROUND_ROBIN',
    "judgeMode" TEXT NOT NULL DEFAULT 'MODEL',
    "judgeTargetId" TEXT,
    "judgeFingerprint" TEXT,
    "judgeSnapshot" JSONB,
    "sampleCount" INTEGER NOT NULL,
    "seed" TEXT NOT NULL,
    "samplePlanHash" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "concurrency" INTEGER NOT NULL DEFAULT 4,
    "targetConcurrency" INTEGER NOT NULL DEFAULT 2,
    "batchSize" INTEGER NOT NULL DEFAULT 50,
    "rpm" INTEGER NOT NULL DEFAULT 600,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "maxRequests" INTEGER NOT NULL,
    "requestsUsed" INTEGER NOT NULL DEFAULT 0,
    "maxDurationMinutes" INTEGER NOT NULL DEFAULT 1440,
    "nextRunIndex" INTEGER NOT NULL DEFAULT 0,
    "stopReason" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_evaluation_samples" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "batch_evaluation_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_evaluation_runs" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetName" TEXT NOT NULL,
    "targetFingerprint" TEXT NOT NULL,
    "targetSnapshot" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL,
    "status" "EvalTaskStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "batch_evaluation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_evaluation_results" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "verdict" "Verdict",
    "severity" "Severity",
    "category" TEXT NOT NULL,
    "response" TEXT,
    "evidence" TEXT[],
    "errorMessage" TEXT,
    "latencyMs" INTEGER,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "judgeAttempts" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "targetAttemptLimit" INTEGER NOT NULL DEFAULT 3,
    "judgeAttemptLimit" INTEGER NOT NULL DEFAULT 3,
    "shouldRefuse" BOOLEAN NOT NULL DEFAULT false,
    "refused" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_evaluation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_evaluation_attempts" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STARTED',
    "httpStatus" INTEGER,
    "latencyMs" INTEGER,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_evaluation_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_evaluation_reports" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_evaluation_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batch_evaluations_createdById_createdAt_idx" ON "batch_evaluations"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "batch_evaluations_status_leaseUntil_idx" ON "batch_evaluations"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "batch_evaluation_samples_planId_sequence_key" ON "batch_evaluation_samples"("planId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "batch_evaluation_runs_planId_targetId_key" ON "batch_evaluation_runs"("planId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "batch_evaluation_runs_planId_position_key" ON "batch_evaluation_runs"("planId", "position");

-- CreateIndex
CREATE INDEX "batch_evaluation_results_runId_status_idx" ON "batch_evaluation_results"("runId", "status");

-- CreateIndex
CREATE INDEX "batch_evaluation_results_runId_verdict_category_idx" ON "batch_evaluation_results"("runId", "verdict", "category");

-- CreateIndex
CREATE UNIQUE INDEX "batch_evaluation_results_runId_sampleId_key" ON "batch_evaluation_results"("runId", "sampleId");

-- CreateIndex
CREATE UNIQUE INDEX "batch_evaluation_attempts_resultId_role_attemptNo_key" ON "batch_evaluation_attempts"("resultId", "role", "attemptNo");

-- CreateIndex
CREATE INDEX "batch_evaluation_reports_planId_createdAt_idx" ON "batch_evaluation_reports"("planId", "createdAt");

-- AddForeignKey
ALTER TABLE "batch_evaluation_samples" ADD CONSTRAINT "batch_evaluation_samples_planId_fkey" FOREIGN KEY ("planId") REFERENCES "batch_evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_evaluation_runs" ADD CONSTRAINT "batch_evaluation_runs_planId_fkey" FOREIGN KEY ("planId") REFERENCES "batch_evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_evaluation_results" ADD CONSTRAINT "batch_evaluation_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "batch_evaluation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_evaluation_results" ADD CONSTRAINT "batch_evaluation_results_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "batch_evaluation_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_evaluation_attempts" ADD CONSTRAINT "batch_evaluation_attempts_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "batch_evaluation_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_evaluation_reports" ADD CONSTRAINT "batch_evaluation_reports_planId_fkey" FOREIGN KEY ("planId") REFERENCES "batch_evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
