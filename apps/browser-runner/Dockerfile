FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/browser-runner/package.json apps/browser-runner/
RUN pnpm install --frozen-lockfile --filter @lse/browser-runner...

COPY apps/browser-runner apps/browser-runner
COPY tsconfig.base.json ./

RUN chown -R pwuser:pwuser /app /tmp
USER pwuser

EXPOSE 8094
CMD ["/app/node_modules/.bin/tsx", "apps/browser-runner/src/index.ts"]
