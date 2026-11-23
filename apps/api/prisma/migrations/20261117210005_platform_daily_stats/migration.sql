-- 2.1.2 / 2.1.3 登录页访问量与安装包下载量：按北京时间切日，每天一行。
CREATE TABLE "platform_daily_stats" (
    "date" DATE NOT NULL,
    "visits" INTEGER NOT NULL DEFAULT 0,
    "downloads" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_daily_stats_pkey" PRIMARY KEY ("date")
);
