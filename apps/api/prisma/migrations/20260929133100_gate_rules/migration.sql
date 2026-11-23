-- CreateTable
CREATE TABLE "gate_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "planId" TEXT,
    "modelTargetId" TEXT,
    "rules" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "gate_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_evaluations" (
    "id" TEXT NOT NULL,
    "gateId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "reasons" JSONB NOT NULL,
    "metrics" JSONB,
    "previousTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "gate_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gate_rules_modelTargetId_idx" ON "gate_rules"("modelTargetId");

-- CreateIndex
CREATE INDEX "gate_rules_planId_idx" ON "gate_rules"("planId");

-- CreateIndex
CREATE INDEX "gate_evaluations_gateId_createdAt_idx" ON "gate_evaluations"("gateId", "createdAt");

-- CreateIndex
CREATE INDEX "gate_evaluations_taskId_idx" ON "gate_evaluations"("taskId");

-- AddForeignKey
ALTER TABLE "gate_evaluations" ADD CONSTRAINT "gate_evaluations_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "gate_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
