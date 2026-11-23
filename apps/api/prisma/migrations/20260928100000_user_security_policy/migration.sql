-- AlterTable: 安全设置（登录失败锁定、密码强制更新、超时登出）
ALTER TABLE "users" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lockedUntil" TIMESTAMP(3),
ADD COLUMN "passwordChangedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "lastActiveAt" TIMESTAMP(3);
