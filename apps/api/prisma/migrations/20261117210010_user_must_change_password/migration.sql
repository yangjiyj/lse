-- 2.9.8 首次登录强制改密：存量用户一律不须改密（默认 false）。
ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
