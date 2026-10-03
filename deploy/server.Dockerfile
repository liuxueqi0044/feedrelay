# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_HOME=/usr/local/share/corepack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

FROM base AS check
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @feedrelay/server build

FROM base AS dependencies
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter @feedrelay/server...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=dependencies --chown=node:node /app /app
COPY --from=check --chown=node:node /app/apps/server/src /app/apps/server/src
USER node
EXPOSE 4100
CMD ["pnpm", "--filter", "@feedrelay/server", "start"]
