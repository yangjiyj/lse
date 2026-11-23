# 大模型安全评估平台 —— 应用镜像（api / worker / migrate 共用 app；web 单独 Caddy）
# 统一基底：Debian glibc + Node 22 + openssl（Prisma 引擎依赖）+ 原生模块编译链（argon2）
# 与 browser-runner 使用同一份已验证的 Playwright Chromium；Debian Chromium 150
# 在当前 Docker 运行环境会以 SIGTRAP(133) 崩溃，只保留其系统依赖，不作为报告渲染器。
FROM mcr.microsoft.com/playwright:v1.61.1-noble AS playwright-browser

FROM node:22-bookworm-slim AS base
# Bootstrap HTTPS trust from the already pinned public Playwright base; never disable TLS verification.
COPY --from=playwright-browser /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
# Use signed official Debian repositories; the previous mirror returns package-download 403.
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf 'deb https://deb.debian.org/debian bookworm main\ndeb https://deb.debian.org/debian bookworm-updates main\ndeb https://security.debian.org/debian-security bookworm-security main\n' > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
# HTML 报告渲染器（REPORT_RENDERER=html）依赖无头 chromium + paged.js；中文字体复用上面的 fonts-noto-cjk。
# 仅在需要 HTML 渲染时安装；puppeteer-core 不自带浏览器，指向系统 chromium。
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
COPY --from=playwright-browser /ms-playwright/chromium-1228/chrome-linux64 /opt/lse-chromium
ENV REPORT_CHROMIUM_PATH=/opt/lse-chromium/chrome
# 构建期即验证浏览器能在本镜像启动，避免运行时静默回退到 PDFKit。
RUN "$REPORT_CHROMIUM_PATH" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --dump-dom about:blank >/tmp/chromium-smoke.html 2>/tmp/chromium-smoke.log \
    && test -s /tmp/chromium-smoke.html \
    && rm -f /tmp/chromium-smoke.html /tmp/chromium-smoke.log
# 经 npm 官方源安装 pnpm；避免第三方镜像未同步安全补丁版本
RUN npm install -g pnpm@9.15.9
WORKDIR /app

# ---- 依赖层：仅复制清单以最大化缓存命中 ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
# 为安装层显式锁定官方源，避免第三方镜像未同步安全补丁版本
RUN echo "registry=https://registry.npmjs.org/" >> .npmrc
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

# ---- 应用镜像：api / worker / migrate 共用（通过 compose command 切换角色）----
FROM deps AS app
ARG LSE_VERSION=1.0.8
ARG LSE_SOURCE_COMMIT=unavailable
LABEL org.opencontainers.image.version=$LSE_VERSION \
      org.opencontainers.image.revision=$LSE_SOURCE_COMMIT
ENV LSE_RELEASE_VERSION=$LSE_VERSION LSE_SOURCE_COMMIT=$LSE_SOURCE_COMMIT
COPY --chown=node:node . .
RUN pnpm exec prisma generate --schema apps/api/prisma/schema.prisma
# 模型文件扫描上传暂存目录（命名卷首次挂载时继承此属主）
RUN mkdir -p /var/lib/lse/model-scan-uploads && chown node:node /var/lib/lse/model-scan-uploads
ENV NODE_ENV=production
USER node
EXPOSE 8090
CMD ["pnpm", "--filter", "@lse/api", "start"]

# ---- web 构建：vite 产出静态 dist ----
FROM deps AS webbuild
COPY --chown=node:node . .
RUN pnpm --filter @lse/web build

# ---- web 运行：Caddy 反向代理（/api -> api:8090）+ 托管 SPA 静态资源 ----
FROM caddy:2-alpine AS web
ARG LSE_VERSION=1.0.8
ARG LSE_SOURCE_COMMIT=unavailable
LABEL org.opencontainers.image.version=$LSE_VERSION \
      org.opencontainers.image.revision=$LSE_SOURCE_COMMIT
ENV LSE_RELEASE_VERSION=$LSE_VERSION LSE_SOURCE_COMMIT=$LSE_SOURCE_COMMIT
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=webbuild /app/apps/web/dist /srv
EXPOSE 80
