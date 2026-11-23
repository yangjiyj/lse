-- 2.1.1 自助注册：手机号、单位、注册审核状态。存量用户和管理员新建的用户都是 NONE。
CREATE TYPE "RegistrationStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "users" ADD COLUMN "phone" TEXT,
ADD COLUMN "organization" TEXT,
ADD COLUMN "registrationStatus" "RegistrationStatus" NOT NULL DEFAULT 'NONE';
