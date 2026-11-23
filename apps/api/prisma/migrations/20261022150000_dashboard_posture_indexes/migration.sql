-- 首页「安全态势」按时间窗聚合：风险回复按创建时间、审计日志按动作+时间过滤
CREATE INDEX IF NOT EXISTS "findings_createdAt_idx" ON "findings"("createdAt");
CREATE INDEX IF NOT EXISTS "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");
