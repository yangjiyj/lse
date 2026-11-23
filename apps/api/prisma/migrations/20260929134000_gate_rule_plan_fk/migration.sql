-- 历史数据：planId 指向不存在计划的门禁先置空，再加外键
UPDATE "gate_rules" SET "planId" = NULL WHERE "planId" IS NOT NULL AND "planId" NOT IN (SELECT "id" FROM "eval_plans");

-- AddForeignKey
ALTER TABLE "gate_rules" ADD CONSTRAINT "gate_rules_planId_fkey" FOREIGN KEY ("planId") REFERENCES "eval_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
