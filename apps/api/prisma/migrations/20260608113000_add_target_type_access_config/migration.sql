-- CreateEnum
CREATE TYPE "TargetType" AS ENUM ('MODEL', 'AGENT_API', 'PUBLIC_AGENT', 'MCP_OPENAPI', 'GATEWAY_LOG');

-- AlterTable
ALTER TABLE "model_targets"
  ADD COLUMN "targetType" "TargetType" NOT NULL DEFAULT 'MODEL',
  ADD COLUMN "accessConfig" JSONB;

-- CreateIndex
CREATE INDEX "model_targets_targetType_idx" ON "model_targets"("targetType");
