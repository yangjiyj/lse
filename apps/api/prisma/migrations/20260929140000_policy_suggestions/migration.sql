-- CreateEnum
CREATE TYPE "PolicySuggestionStatus" AS ENUM ('DRAFT', 'ACCEPTED', 'MODIFIED', 'REJECTED', 'DISPATCHED', 'GATEWAY_PENDING', 'PUBLISHED', 'GATEWAY_REJECTED');

-- CreateTable
CREATE TABLE "policy_suggestions" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "modelTargetId" TEXT NOT NULL,
    "riskCategory" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "matcherKind" TEXT NOT NULL,
    "matcherValue" JSONB NOT NULL,
    "generatedMatcher" JSONB NOT NULL,
    "examples" JSONB NOT NULL,
    "sourceFindingIds" TEXT[],
    "estimatedImpact" JSONB NOT NULL,
    "generationNote" TEXT,
    "status" "PolicySuggestionStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "gatewaySuggestionId" TEXT,
    "gatewayStatus" TEXT,
    "ruleSetId" TEXT,
    "ruleSetVersion" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "dispatchedById" TEXT,
    "dispatchError" TEXT,
    "lastPolledAt" TIMESTAMP(3),
    "pollDeadlineAt" TIMESTAMP(3),
    "pollExpired" BOOLEAN NOT NULL DEFAULT false,
    "preFailCount" INTEGER,
    "preTotalCount" INTEGER,
    "preAttackRate" DOUBLE PRECISION,
    "postFailCount" INTEGER,
    "postTotalCount" INTEGER,
    "postAttackRate" DOUBLE PRECISION,
    "retestStatus" TEXT,
    "retestError" TEXT,
    "retestTaskId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "policy_suggestions_externalId_key" ON "policy_suggestions"("externalId");

-- CreateIndex
CREATE INDEX "policy_suggestions_taskId_idx" ON "policy_suggestions"("taskId");

-- CreateIndex
CREATE INDEX "policy_suggestions_status_idx" ON "policy_suggestions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "policy_suggestions_scopeKey_groupKey_key" ON "policy_suggestions"("scopeKey", "groupKey");

-- AddForeignKey
ALTER TABLE "policy_suggestions" ADD CONSTRAINT "policy_suggestions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "eval_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_suggestions" ADD CONSTRAINT "policy_suggestions_retestTaskId_fkey" FOREIGN KEY ("retestTaskId") REFERENCES "eval_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
